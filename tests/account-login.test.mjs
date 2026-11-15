import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, chmod, writeFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request, Server } from 'node:http';
import { AccountManager } from '../dist/account/index.js';

async function fixture(t, vendorRequest, verifyTotp) {
  const directory = await mkdtemp(join(tmpdir(), 'bambu-account-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new AccountManager({sessionDirectory: directory, vendor: {request: vendorRequest, verifyTotp}});
  t.after(() => manager.cancelInteractiveLogin());
  return {directory, manager};
}
async function post(url, obj, headers = {}) {
  return fetch(url, {method:'POST', headers:{origin:new URL(url).origin, 'content-type':'application/json', ...headers}, body:JSON.stringify(obj)});
}
const token = 'SYNTHETIC-TOKEN-PRIVATE';
const good = {accessToken:token, expiresIn:3600};

test('one-shot login persists privately and returns only sanitized binding and status', async t => {
  const calls = [];
  const {directory,manager} = await fixture(t, async (region,path,body,secret) => {
    calls.push({region,path,body,secret});
    if (path.endsWith('/login')) return good;
    if (path.endsWith('/bind')) return {devices:[{dev_id:'SERIAL1',name:'Printer',dev_product_name:'X2D',dev_access_code:'SECRET-CODE'}]};
    return {uid:12345};
  });
  assert.deepEqual(await manager.status(), {state:'not_configured',loginInProgress:false});
  const flow = await manager.beginInteractiveLogin({region:'global'});
  const page = await fetch(flow.url); assert.equal(page.status,200); assert.match(await page.text(), /Bambu account sign in/);
  const result = await post(flow.url,{action:'login',account:'dummy',password:'PASSWORD-PRIVATE'});
  assert.deepEqual(await result.json(), {state:'complete'});
  await new Promise(resolve => setTimeout(resolve,30));
  assert.equal((await manager.status()).state,'ready');
  assert.deepEqual(await manager.listPrinters(), [{serial:'SERIAL1',name:'Printer',model:'X2D'}]);
  const credential = await manager.getCloudMqttCredentials('SERIAL1');
  assert.deepEqual({url:credential.url,username:credential.username,password:credential.password}, {url:'mqtts://us.mqtt.bambulab.com:8883',username:'u_12345',password:token});
  await credential.assertCurrent(); credential.assertGenerationCurrent();
  await assert.rejects(manager.getCloudMqttCredentials('OTHER'), /not uniquely bound/);
  const saved = await readFile(join(directory,'session.json'),'utf8');
  assert.equal(saved.includes('PASSWORD-PRIVATE'),false); assert.equal((await stat(join(directory,'session.json'))).mode & 0o777,0o600);
  assert.equal(JSON.stringify(await manager.status()).includes(token),false);
  assert.equal(JSON.stringify(await manager.listPrinters()).includes('SECRET-CODE'),false);
  assert.equal(calls[0].body.password,'PASSWORD-PRIVATE');
  await manager.logout(); assert.equal((await manager.status()).state,'not_configured');
});

test('challenge, wrong code, and TOTP are handled without returning challenge secrets', async t => {
  let mode = 'email';
  const {manager} = await fixture(t, async (_region,path,body) => {
    if (body.password) return mode === 'email' ? {loginType:'verifyCode'} : {loginType:'tfa',tfaKey:'PRIVATE-KEY'};
    if (body.code === '000000') return {message:'bad PASSWORD-PRIVATE'};
    assert.equal(path.endsWith('/user/login'),true);
    return good;
  }, async (_region, key, code) => { assert.equal(key,'PRIVATE-KEY'); return code === '000000' ? {} : good; });
  for (const kind of ['email','totp']) {
    mode = kind;
    const flow = await manager.beginInteractiveLogin({region:'china'});
    const start = await (await post(flow.url,{action:'login',account:'dummy',password:'PASSWORD-PRIVATE'})).text();
    assert.deepEqual(JSON.parse(start), {state:kind}); assert.ok(!start.includes('PRIVATE-KEY'));
    const invalid = await (await post(flow.url,{action:'verify',code:'000000'})).text();
    assert.ok(!invalid.includes('PASSWORD-PRIVATE')); assert.equal(JSON.parse(invalid).state,'error');
    assert.deepEqual(await (await post(flow.url,{action:'verify',code:'123456'})).json(), {state:'complete'});
    await new Promise(resolve => setTimeout(resolve,30));
  }
});

test('rejects CSRF, wrong nonce, bad host, malformed input and cancellation closes listener', async t => {
  let calls=0;
  const {manager} = await fixture(t, async () => { calls++; return good; });
  const flow = await manager.beginInteractiveLogin({region:'global'});
  assert.equal((await post(flow.url,{action:'login',account:'a',password:'p'},{origin:'https://attacker.invalid'})).status,403);
  const badHost = await new Promise((resolve,reject) => { const u=new URL(flow.url); const req=request({hostname:u.hostname,port:u.port,path:u.pathname,headers:{host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode)}); req.on('error',reject); req.end(); });
  assert.equal(badHost,403);
  assert.equal((await fetch(flow.url+'bad')).status,403);
  assert.equal((await post(flow.url,{action:'login',account:'a'})).status,400);
  assert.equal(calls,0);
  assert.deepEqual(await (await post(flow.url,{action:'cancel'})).json(),{state:'cancelled'});
  assert.equal((await manager.status()).loginInProgress,false);
  await assert.rejects(fetch(flow.url));
});

test('vendor failures are redacted, expiry and session permissions fail closed', async t => {
  const {directory,manager} = await fixture(t, async () => {throw new Error('secret vendor details');});
  const flow=await manager.beginInteractiveLogin({region:'global'});
  const response = await (await post(flow.url,{action:'login',account:'a',password:'p'})).text();
  assert.doesNotMatch(response,/secret vendor details/);
  manager.cancelInteractiveLogin();
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,region:'global',token,expiresAt:Date.now()-1000}),{mode:0o600});
  assert.equal((await manager.status()).state,'expired');
  await assert.rejects(manager.listPrinters(),/expired/);
  await chmod(join(directory,'session.json'),0o644);
  await assert.rejects(manager.status(),/private account session/);
});

test('production vendor requests use documented hosts and TOTP cookie exchange', {concurrency:false}, async t => {
  const original = globalThis.fetch;
  const realFetch = original;
  const calls = [];
  let count=0;
  globalThis.fetch = async (url, options={}) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url,options);
    calls.push({url:String(url), options});
    if (String(url).endsWith('/user/login')) return new Response(JSON.stringify({loginType:'tfa',tfaKey:'PRIVATE-CHALLENGE'}));
    if (String(url).endsWith('/api/csrf')) return new Response(null,{status:204,headers:{'set-cookie':'bbl_csrf_token=csrf-secret; Path=/; Secure'}});
    if (String(url).endsWith('/api/sign-in/tfa')) { count++; return new Response(null,{status:200,headers:{'set-cookie':`token=${token}; Path=/; Secure`}}); }
    throw new Error('unexpected network request');
  };
  t.after(() => {globalThis.fetch=original;});
  const directory=await mkdtemp(join(tmpdir(),'bambu-vendor-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new AccountManager({sessionDirectory:directory}); t.after(()=>manager.cancelInteractiveLogin());
  const flow=await manager.beginInteractiveLogin({region:'china'});
  assert.deepEqual(await (await post(flow.url,{action:'login',account:'dummy',password:'PASSWORD-PRIVATE'})).json(),{state:'totp'});
  assert.deepEqual(await (await post(flow.url,{action:'verify',code:'123456'})).json(),{state:'complete'});
  assert.equal(count,1);
  assert.deepEqual(calls.map(c=>c.url),['https://api.bambulab.cn/v1/user-service/user/login','https://bambulab.cn/api/csrf','https://bambulab.cn/api/sign-in/tfa']);
  assert.deepEqual(JSON.parse(calls[0].options.body),{account:'dummy',password:'PASSWORD-PRIVATE',apiError:''});
  assert.equal(calls[2].options.headers['x-bbl-csrf-token'],'csrf-secret');
  assert.deepEqual(JSON.parse(calls[2].options.body),{tfaKey:'PRIVATE-CHALLENGE',tfaCode:'123456'});
  assert.equal((await manager.status()).state,'ready');
  assert.equal((await manager.status()).expiresAt,undefined);
});

test('expired verification code and rate limits surface safe errors; resending requires a click', {concurrency:false}, async t => {
  const original=globalThis.fetch; let sends=0;
  globalThis.fetch=async (url,opts={})=>{
    if(String(url).startsWith('http://127.0.0.1:')) return original(url,opts);
    if(String(url).endsWith('/sendemail/code')) {sends++; return new Response('{}');}
    const body=JSON.parse(opts.body);
    if(body.password) return new Response(JSON.stringify({loginType:'verifyCode'}));
    if(body.code==='111111') return new Response(JSON.stringify({code:1,secret:'never reveal'}),{status:400});
    return new Response('never reveal',{status:429});
  };
  t.after(()=>{globalThis.fetch=original;});
  const directory=await mkdtemp(join(tmpdir(),'bambu-vendor-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const manager=new AccountManager({sessionDirectory:directory});t.after(()=>manager.cancelInteractiveLogin());
  const flow=await manager.beginInteractiveLogin({region:'global'});
  await post(flow.url,{action:'login',account:'dummy@example.test',password:'secret'});
  assert.equal(sends,0);
  assert.deepEqual(await (await post(flow.url,{action:'verify',code:'111111'})).json(),{state:'error',message:'Verification code expired.'});
  assert.deepEqual(await (await post(flow.url,{action:'verify',code:'222222'})).json(),{state:'error',message:'Bambu rate limit reached; try again later.'});
  await post(flow.url,{action:'resend'}); assert.equal(sends,1);
});

test('concurrent flows are rejected and cancelled in-flight login cannot save a session', async t => {
  let release, started;
  const called = new Promise(resolve => {started=resolve;});
  const pending = new Promise(resolve => {release=resolve;});
  const {manager}=await fixture(t, async()=>{started();return pending;});
  const [first,second]=await Promise.allSettled([manager.beginInteractiveLogin({region:'global'}),manager.beginInteractiveLogin({region:'global'})]);
  assert.equal(first.status,'fulfilled'); assert.equal(second.status,'rejected');
  const result=post(first.value.url,{action:'login',account:'dummy',password:'dummy'}).catch(()=>{});
  await called; manager.cancelInteractiveLogin(); release(good); await result;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await manager.status()).state,'not_configured');
});

test('JWT metadata uses its account username and rejects malformed identities', async t => {
  const {directory,manager}=await fixture(t,async (_region,path)=>{
    if(path.endsWith('/bind')) return {devices:[{dev_id:'ABC'}]};
    throw new Error('preference fallback must not run for a JWT');
  });
  const file=join(directory,'session.json');
  const write=async token=>writeFile(file,JSON.stringify({version:1,region:'global',token,expiresAt:null}),{mode:0o600});
  await write(`a.${Buffer.from(JSON.stringify({username:'u_777'})).toString('base64url')}.c`);
  assert.equal((await manager.getCloudMqttCredentials('ABC')).username,'u_777');
  await write(`a.${Buffer.from(JSON.stringify({username:'unexpected'})).toString('base64url')}.c`);
  await assert.rejects(manager.getCloudMqttCredentials('ABC'),/invalid account identity/);
});

test('cancel and logout cover starting listeners without cancelling a superseding flow', async t => {
  const {manager} = await fixture(t, async()=>good);
  const first=manager.beginInteractiveLogin({region:'global'});
  manager.cancelInteractiveLogin();
  const second=manager.beginInteractiveLogin({region:'global'});
  await assert.rejects(first,/cancelled/);
  const flow=await second;
  assert.equal((await fetch(flow.url)).status,200);
  manager.cancelInteractiveLogin();
  const third=manager.beginInteractiveLogin({region:'global'});
  const cancelled=assert.rejects(third,/cancelled/);
  await manager.logout();
  await cancelled;
  assert.equal((await manager.status()).loginInProgress,false);
});

test('logout invalidates credentials waiting on binding, and queued guards', async t => {
  let release, started; let block=false;
  const called=new Promise(resolve=>{started=resolve});
  const pending=new Promise(resolve=>{release=resolve});
  const {manager,directory}=await fixture(t,async (_region,path)=>{
    if(path.endsWith('/bind')) { if(block){started();await pending;} return {devices:[{dev_id:'ABC'}]}; }
    return {uid:123};
  });
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,region:'global',token,expiresAt:null}),{mode:0o600});
  const queued=await manager.getCloudMqttCredentials('ABC');
  block=true; const inFlight=manager.getCloudMqttCredentials('ABC');
  await called; await manager.logout();
  assert.throws(()=>queued.assertGenerationCurrent(),/authority changed/);
  await assert.rejects(queued.assertCurrent());
  release(); await assert.rejects(inFlight,/authority changed|missing or expired/);
});

test('account rotation invalidates old queued credentials and delayed binding', async t => {
  let release, started; let block=false;
  const called=new Promise(resolve=>{started=resolve});
  const pending=new Promise(resolve=>{release=resolve});
  const {manager,directory}=await fixture(t,async (_region,path,body)=>{
    if(path.endsWith('/bind')) {if(block){started();await pending;} return {devices:[{dev_id:'ABC'}]};}
    if(body?.password) return {accessToken:'new-token',expiresIn:3600};
    return {uid:123};
  });
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,region:'global',token,expiresAt:null}),{mode:0o600});
  const old=await manager.getCloudMqttCredentials('ABC');
  block=true; const inFlight=manager.getCloudMqttCredentials('ABC'); await called;
  const flow=await manager.beginInteractiveLogin({region:'global'});
  assert.deepEqual(await (await post(flow.url,{action:'login',account:'dummy',password:'dummy'})).json(),{state:'complete'});
  assert.throws(()=>old.assertGenerationCurrent(),/authority changed/);
  await assert.rejects(old.assertCurrent(),/authority changed/);
  release(); await assert.rejects(inFlight,/authority changed/);
});

test('async guard detects another manager replacing or removing the shared session', async t => {
  const {directory,manager}=await fixture(t,async (_region,path)=>path.endsWith('/bind') ? {devices:[{dev_id:'ABC'}]} : {uid:123});
  const file=join(directory,'session.json');
  await writeFile(file,JSON.stringify({version:1,region:'global',token,expiresAt:null}),{mode:0o600});
  const old=await manager.getCloudMqttCredentials('ABC');
  await writeFile(file,JSON.stringify({version:1,region:'global',token:'replacement',expiresAt:null}),{mode:0o600});
  old.assertGenerationCurrent(); // This guard is deliberately process-local.
  await assert.rejects(old.assertCurrent(),/authority changed/);
  await rm(file);
  await assert.rejects(old.assertCurrent());
});

test('delayed listener startup is rejected and closed after cancellation, without harming the replacement', async t => {
  const original=Server.prototype.listen;
  let resume, delayedServer;
  Server.prototype.listen=function(...args) {
    if (!resume) { delayedServer=this; resume=()=>original.apply(this,args); return this; }
    return original.apply(this,args);
  };
  t.after(()=>{Server.prototype.listen=original;});
  const {manager}=await fixture(t,async()=>good);
  const old=manager.beginInteractiveLogin({region:'global'});
  const rejected=assert.rejects(old,/cancelled/);
  assert.ok(resume);
  manager.cancelInteractiveLogin();
  const replacement=await manager.beginInteractiveLogin({region:'global'});
  resume(); await rejected;
  assert.equal(delayedServer.listening,false);
  assert.equal((await fetch(replacement.url)).status,200);
});

test('logout waits for an in-flight atomic session rename and leaves no token', async t => {
  const {manager}=await fixture(t,async()=>good);
  const flow=await manager.beginInteractiveLogin({region:'global'});
  const original=fsPromises.rename;
  let release, reached;
  const entered=new Promise(resolve=>{reached=resolve});
  const wait=new Promise(resolve=>{release=resolve});
  fsPromises.rename=async (...args)=>{ reached(); await wait; return original(...args); };
  t.after(()=>{fsPromises.rename=original;});
  const request=post(flow.url,{action:'login',account:'dummy',password:'dummy'}).catch(()=>{});
  await entered;
  const logout=manager.logout();
  release(); await logout; await request;
  assert.equal((await manager.status()).state,'not_configured');
});
