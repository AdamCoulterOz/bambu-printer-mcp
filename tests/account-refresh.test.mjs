import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountManager} from '../dist/account/index.js';
import {withAccountLock} from '../dist/account/session-store.js';

async function fixture(fn) {
  const dir=await mkdtemp(join(tmpdir(),'bambu-refresh-'));
  try {
    await writeFile(join(dir,'session.json'),JSON.stringify({version:1,region:'global',token:'old',expiresAt:Date.now()-1000,refreshToken:'refresh-old',refreshExpiresAt:Date.now()+3600000,identity:'u_42'}),{mode:0o600});
    await fn(dir);
  } finally {await rm(dir,{recursive:true,force:true});}
}

test('concurrent managers serialize rotation and install the new refresh token atomically', async () => fixture(async dir => {
  let exchanges=0;
  const vendor={request:async (_region,path,body,token) => {
    if(path.endsWith('/refreshtoken')) {exchanges++;assert.deepEqual(body,{refreshToken:'refresh-old'});await new Promise(r=>setTimeout(r,40));return {accessToken:'new',refreshToken:'refresh-new',expiresIn:3600,refreshExpiresIn:7200};}
    if(path.endsWith('/preference')) {assert.equal(token,'new');return {uid:42};}
    if(path.endsWith('/bind')) {assert.equal(token,'new');return {devices:[{dev_id:'device'}]};}
    throw Error('unexpected');
  }};
  const a=new AccountManager({sessionDirectory:dir,vendor}),b=new AccountManager({sessionDirectory:dir,vendor});
  await Promise.all([a.listPrinters(),b.listPrinters()]);
  assert.equal(exchanges,1);
  const stored=JSON.parse(await readFile(join(dir,'session.json'),'utf8'));
  assert.equal(stored.token,'new');assert.equal(stored.refreshToken,'refresh-new');assert.equal(stored.refreshPending,undefined);
  assert.equal((await a.status()).refreshState,'available');
}));

test('an uncertain exchange is journaled and never automatically repeated', async () => fixture(async dir => {
  let exchanges=0;
  const vendor={request:async () => {exchanges++;throw Error('network error');}};
  const manager=new AccountManager({sessionDirectory:dir,vendor});
  await assert.rejects(manager.listPrinters(),/uncertain/);
  await assert.rejects(manager.listPrinters(),/uncertain/);
  assert.equal(exchanges,1);
  assert.equal((await manager.status()).refreshState,'reauth_required');
}));

test('a rotated token for another identity remains journaled and unusable', async () => fixture(async dir => {
  const vendor={request:async (_r,path) => path.endsWith('/refreshtoken') ? {accessToken:'new',expiresIn:3600} : {uid:99}};
  const manager=new AccountManager({sessionDirectory:dir,vendor});
  await assert.rejects(manager.listPrinters(),/uncertain/);
  assert.equal((await manager.status()).refreshState,'reauth_required');
}));

test('opaque refresh with missing preference UID stays journaled and is never retried', async () => fixture(async dir => {
  let exchanges=0;
  const vendor={request:async (_region,path,_body,token) => {
    if(path.endsWith('/refreshtoken')) { exchanges++; return {accessToken:'opaque-new',refreshToken:'rotated',expiresIn:3600}; }
    if(path.endsWith('/preference')) { assert.equal(token,'opaque-new'); return {}; }
    throw Error('unexpected request');
  }};
  const manager=new AccountManager({sessionDirectory:dir,vendor});
  await assert.rejects(manager.listPrinters(),/uncertain/);
  await assert.rejects(manager.listPrinters(),/uncertain/);
  assert.equal(exchanges,1);
  const stored=JSON.parse(await readFile(join(dir,'session.json'),'utf8'));
  assert.equal(stored.refreshPending,true);
  assert.equal(stored.token,'old');
}));

test('logout racing an exchange invalidates the result and removes the journal', async () => fixture(async dir => {
  let begin, finish;
  const started=new Promise(r=>{begin=r;});
  const blocked=new Promise(r=>{finish=r;});
  const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async (_r,path)=>{
    if(path.endsWith('/refreshtoken')) {begin(); await blocked; return {accessToken:'new',expiresIn:3600};}
    return {uid:42};
  }}});
  const refreshing=manager.listPrinters();
  await started;
  const logout=manager.logout();finish();
  await assert.rejects(refreshing,/uncertain/);
  await logout;
  assert.equal((await manager.status()).state,'not_configured');
}));

test('a refused history GET refreshes once and rechecks the binding before returning', async () => fixture(async dir => {
  await writeFile(join(dir,'session.json'),JSON.stringify({version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'}),{mode:0o600});
  let exchanges=0, calls=0;
  const vendor={request:async (_r,path,_body,token) => {
    if(path.endsWith('/refreshtoken')) {exchanges++;return {accessToken:'new',refreshToken:'rotated',expiresIn:3600};}
    if(path.endsWith('/preference')) return {uid:42};
    if(path.endsWith('/bind')) return {devices:[{dev_id:'device'}]};
    throw Error('unexpected');
  }};
  const manager=new AccountManager({sessionDirectory:dir,vendor});
  const oldFetch=globalThis.fetch;
  try {
    globalThis.fetch=async (_url,options)=>{
      calls++;
      return options.headers.authorization==='Bearer old' ? new Response('',{status:401}) : new Response(JSON.stringify({total:1,hits:[{id:1,deviceId:'device'}]}));
    };
    const page=await manager.cloudPrintHistoryPage('device',{},{});
    assert.equal(page.tasks.length,1);assert.equal(calls,2);assert.equal(exchanges,1);
  } finally {globalThis.fetch=oldFetch;}
}));

test('an authentication refusal on a mutation is never replayed', async () => fixture(async dir => {
  await writeFile(join(dir,'session.json'),JSON.stringify({version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'}),{mode:0o600});
  let exchanges=0,calls=0;
  const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>{exchanges++;return {};}}});
  const oldFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{calls++;return new Response('',{status:401});};
    await assert.rejects(manager.filamentAction('delete',{ids:[1]},'device',{}),/HTTP 401/);
    assert.equal(calls,1); assert.equal(exchanges,0);
  } finally {globalThis.fetch=oldFetch;}
}));

test('a refused binding GET rotates once before issuing fresh guarded credentials', async () => fixture(async dir => {
  await writeFile(join(dir,'session.json'),JSON.stringify({version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'}),{mode:0o600});
  const manager=new AccountManager({sessionDirectory:dir});
  const oldFetch=globalThis.fetch;let refreshes=0,binds=0;
  try {
    globalThis.fetch=async (url,options)=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/refreshtoken')) {refreshes++;return new Response(JSON.stringify({accessToken:'new',refreshToken:'rotated',expiresIn:3600}));}
      if(path.endsWith('/preference')) return new Response(JSON.stringify({uid:42}));
      if(path.endsWith('/bind')) {binds++;return options.headers.authorization==='Bearer old' ? new Response('',{status:401}) : new Response(JSON.stringify({devices:[{dev_id:'device'}]}));}
      throw Error('unexpected');
    };
    const credentials=await manager.getCloudMqttCredentials('device');
    assert.equal(credentials.username,'u_42'); await credentials.assertCurrent();
    assert.equal(refreshes,1);assert.equal(binds,2);
  } finally {globalThis.fetch=oldFetch;}
}));

test('another process changing the saved account invalidates an in-flight read', async () => fixture(async dir => {
  const current={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(current),{mode:0o600});
  const vendor={request:async (_r,path)=>path.endsWith('/bind') ? {devices:[{dev_id:'device'}]} : {uid:42}};
  const manager=new AccountManager({sessionDirectory:dir,vendor});
  const oldFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{
      await writeFile(join(dir,'session.json'),JSON.stringify({...current,token:'other-account'}),{mode:0o600});
      return new Response(JSON.stringify({total:1,hits:[{id:1,deviceId:'device'}]}));
    };
    await assert.rejects(manager.cloudPrintHistoryPage('device',{},{}),/Invalid Bambu cloud response|authority changed/);
  } finally {globalThis.fetch=oldFetch;}
}));

for (const mode of ['history','cover','inventory','printers','credentials']) test(`401 racing another account login cannot replay ${mode} under the new account`, async () => fixture(async dir => {
  const a={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(a),{mode:0o600});
  const manager=new AccountManager({sessionDirectory:dir});const oldFetch=globalThis.fetch;
  let bRequests=0,refusals=0;
  try {
    globalThis.fetch=async (url,options)=>{
      const path=new URL(url).pathname;
      if(options.headers?.authorization==='Bearer other') bRequests++;
      if(path.endsWith('/preference')) return new Response(JSON.stringify({uid:42}));
      const target = mode==='inventory' ? path.includes('/filament/v2') : mode==='history' ? path.endsWith('/my/tasks') : mode==='cover' ? path.endsWith('/my/task/42') : path.endsWith('/bind');
      if(target) {
        refusals++;
        await writeFile(join(dir,'session.json'),JSON.stringify({...a,token:'other',identity:'u_99'}),{mode:0o600});
        await writeFile(join(dir,'.authority'),'0123456789abcdef0123456789abcdef',{mode:0o600});
        return new Response('',{status:401});
      }
      if(path.endsWith('/bind')) return new Response(JSON.stringify({devices:[{dev_id:'device'}]}));
      throw Error('unexpected request');
    };
    const invoke=mode==='history'?()=>manager.cloudPrintHistoryPage('device',{},{}):mode==='cover'?()=>manager.cloudPrintHistoryCover('device',42,{}):mode==='inventory'?()=>manager.listFilamentInventory({}):mode==='printers'?()=>manager.listPrinters():()=>manager.getCloudMqttCredentials('device');
    await assert.rejects(invoke(),/authority changed/i);
    assert.equal(refusals,1);assert.equal(bRequests,0);
  } finally {globalThis.fetch=oldFetch;}
}));

for (const replacement of [undefined,null,'refresh-old']) test(`successful refresh retains the official-client token when replacement is ${replacement}`, async () => fixture(async dir => {
  const before=JSON.parse(await readFile(join(dir,'session.json'),'utf8'));
  let calls=0;
  const vendor={request:async (_r,path)=>{
    if(path.endsWith('/refreshtoken')) {calls++;return {accessToken:'new',expiresIn:3600,...(replacement===undefined?{}:{refreshToken:replacement})};}
    if(path.endsWith('/preference')) return {uid:42};
    return {devices:[]};
  }};
  const manager=new AccountManager({sessionDirectory:dir,vendor});await manager.listPrinters();
  const saved=JSON.parse(await readFile(join(dir,'session.json'),'utf8'));
  assert.equal(saved.token,'new');assert.equal(saved.refreshToken,'refresh-old');assert.equal(saved.refreshExpiresAt,before.refreshExpiresAt);assert.equal((await manager.status()).refreshState,'available');assert.equal(calls,1);
}));

test('helper death during a held operation does not let a second login pass the lock', async () => fixture(async dir => {
  let finish, ready;
  const started=new Promise(r=>{ready=r;});const blocked=new Promise(r=>{finish=r;});
  const first=withAccountLock(dir,async()=>{ready();await blocked;},undefined,pid=>process.kill(pid,'SIGKILL'));
  await started;
  const manager=new AccountManager({sessionDirectory:dir});let began=false;
  const second=manager.beginInteractiveLogin({region:'global'}).then(v=>{began=true;return v;});
  await new Promise(r=>setTimeout(r,80));assert.equal(began,false);
  finish();await first;await second;manager.cancelInteractiveLogin();
}));

test('helper death during the refresh vendor call cannot let another login overtake publication', async () => fixture(async dir => {
  let pid,ready,release;const entered=new Promise(r=>{ready=r;}),blocked=new Promise(r=>{release=r;});
  const vendor={request:async (_r,path)=>{
    if(path.endsWith('/refreshtoken')) {ready();await blocked;return {accessToken:'new',refreshToken:'rotated',expiresIn:3600};}
    if(path.endsWith('/preference')) return {uid:42};
    return {devices:[]};
  }};
  const a=new AccountManager({sessionDirectory:dir,vendor,lockObserverForTest:value=>{pid=value;}});
  const b=new AccountManager({sessionDirectory:dir});const refresh=a.listPrinters();await entered;
  process.kill(pid,'SIGKILL');let began=false;
  const login=b.beginInteractiveLogin({region:'global'}).then(value=>{began=true;return value;});
  await new Promise(r=>setTimeout(r,80));assert.equal(began,false);
  release();await refresh;await login;b.cancelInteractiveLogin();
}));

test('cross-process logout fences an older open browser login', async () => fixture(async dir => {
  const a=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>({accessToken:'token',expiresIn:3600})}});
  const b=new AccountManager({sessionDirectory:dir});
  const flow=await a.beginInteractiveLogin({region:'global'});await b.logout();
  const result=await fetch(flow.url,{method:'POST',headers:{'content-type':'application/json',origin:new URL(flow.url).origin},body:JSON.stringify({action:'login',account:'a',password:'b'})});
  assert.equal((await result.json()).state,'error');assert.equal((await b.status()).state,'not_configured');a.cancelInteractiveLogin();
}));

test('cancel while waiting for the OS lock does not start a refresh exchange later', async () => fixture(async dir => {
  let finish,ready;const entered=new Promise(r=>{ready=r;}),blocked=new Promise(r=>{finish=r;});
  const held=withAccountLock(dir,async()=>{ready();await blocked;});await entered;
  let calls=0;const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>{calls++;throw Error('unexpected');}}});
  const controller=new AbortController();const pending=manager.listFilamentInventory({},controller.signal);
  await new Promise(r=>setTimeout(r,40));controller.abort();
  await assert.rejects(pending);finish();await held;await new Promise(r=>setTimeout(r,30));
  assert.equal(calls,0);
}));

test('logout while refresh waits for the lock prevents the exchange', async () => fixture(async dir => {
  let finish,ready;const entered=new Promise(r=>{ready=r;}),blocked=new Promise(r=>{finish=r;});
  const held=withAccountLock(dir,async()=>{ready();await blocked;});await entered;
  let calls=0;const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>{calls++;throw Error('unexpected');}}});
  const pending=manager.listFilamentInventory({});
  await new Promise(r=>setTimeout(r,40));const logout=manager.logout();
  finish();await held;await assert.rejects(pending,/authority changed/);await logout;
  assert.equal(calls,0);assert.equal((await manager.status()).state,'not_configured');
}));

test('a replacement token with unchanged local identity must still match server identity before retry', async () => fixture(async dir => {
  const a={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,refreshToken:'refresh-old',identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(a),{mode:0o600});
  const manager=new AccountManager({sessionDirectory:dir});const original=globalThis.fetch;let secondBinding=false;
  try {
    globalThis.fetch=async (url,opts)=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/bind')) {
        if(opts.headers.authorization==='Bearer other') secondBinding=true;
        await writeFile(join(dir,'session.json'),JSON.stringify({...a,token:'other'}),{mode:0o600});
        return new Response('',{status:401});
      }
      if(path.endsWith('/preference')) return new Response(JSON.stringify({uid:99}));
      throw Error('unexpected');
    };
    await assert.rejects(manager.getCloudMqttCredentials('device'),/authority changed/);
    assert.equal(secondBinding,false);
  } finally {globalThis.fetch=original;}
}));

test('logout intent during the second session read prevents the original mutation', async () => fixture(async dir => {
  const a={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(a),{mode:0o600});
  let unlock,locked;const enteredLock=new Promise(r=>{locked=r;}),waitLock=new Promise(r=>{unlock=r;});
  const held=withAccountLock(dir,async()=>{locked();await waitLock;});await enteredLock;
  const manager=new AccountManager({sessionDirectory:dir});const originalLoad=manager.load.bind(manager);
  let count=0,ready,release;const reached=new Promise(r=>{ready=r;}),blocked=new Promise(r=>{release=r;});
  manager.load=async()=>{count++;const value=await originalLoad();if(count===2){ready();await blocked;}return value;};
  let writes=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{writes++;return new Response('{}');};
  try {
    const action=manager.filamentAction('delete',{ids:[1]},'device',{});await reached;
    const logout=manager.logout();
    await assert.rejects(manager.filamentAction('delete',{ids:[2]},'device',{}),/logout in progress/);
    release();await assert.rejects(action,/authority changed|logout in progress/);assert.equal(writes,0);
    unlock();await held;await logout;
  } finally {globalThis.fetch=oldFetch;unlock();}
}));

for (const mode of ['history','cover']) test(`account replacement after ${mode} binding cannot send the initial GET under the replacement`, async () => fixture(async dir => {
  const a={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(a),{mode:0o600});
  const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async (_r,path)=>path.endsWith('/bind')?{devices:[{dev_id:'device'}]}:{uid:42}}});
  const original=manager.getConfiguredCloudMqttCredentials.bind(manager);
  manager.getConfiguredCloudMqttCredentials=async (...args)=>{
    const credentials=await original(...args);
    await writeFile(join(dir,'session.json'),JSON.stringify({...a,token:'other',identity:'u_99'}),{mode:0o600});
    await writeFile(join(dir,'.authority'),'0123456789abcdef0123456789abcdef',{mode:0o600});
    return credentials;
  };
  const oldFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}');};
  try {
    const invoke=mode==='history'?()=>manager.cloudPrintHistoryPage('device',{},{}):()=>manager.cloudPrintHistoryCover('device',42,{});
    await assert.rejects(invoke(),/authority changed/);assert.equal(calls,0);
  } finally {globalThis.fetch=oldFetch;}
}));

for (const mode of ['mutation','history','paged history']) test(`queued ${mode} cannot adopt another manager's account`, async () => fixture(async dir => {
  const a={version:1,region:'global',token:'old',expiresAt:Date.now()+3600000,identity:'u_42'};
  await writeFile(join(dir,'session.json'),JSON.stringify(a),{mode:0o600});
  const manager=new AccountManager({sessionDirectory:dir});
  const other=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>({accessToken:'other',expiresIn:3600})}});
  const oldFetch=globalThis.fetch;let release,started,captured,network=0;
  const entered=new Promise(r=>{started=r;}),blocked=new Promise(r=>{release=r;}),admitted=new Promise(r=>{captured=r;});
  try {
    globalThis.fetch=async (_url,opts)=>{network++;assert.equal(opts.headers.authorization,'Bearer old');started();await blocked;return new Response('{}');};
    const first=manager.filamentAction('delete',{ids:[1]},'device',{});await entered;
    const originalEpoch=manager.authorityEpoch.bind(manager);let epochReads=0;
    manager.authorityEpoch=async()=>{const value=await originalEpoch();if(++epochReads===2)captured();return value;};
    const queued=mode==='mutation'?manager.filamentAction('delete',{ids:[2]},'device',{}):mode==='history'?manager.cloudPrintHistory('device',{}):manager.cloudPrintHistoryPage('device',{},{});
    await admitted;await new Promise(r=>setImmediate(r));
    const flow=await other.beginInteractiveLogin({region:'global'});
    // Exercise the real browser login without routing through the cloud fetch stub.
    globalThis.fetch=oldFetch;
    const response=await fetch(flow.url,{method:'POST',headers:{'content-type':'application/json',origin:new URL(flow.url).origin},body:JSON.stringify({action:'login',account:'b',password:'b'})});
    assert.equal((await response.json()).state,'complete');
    globalThis.fetch=async()=>{network++;throw Error('unexpected cloud request');};
    release();await first.catch(()=>{});await assert.rejects(queued,/authority changed/);assert.equal(network,1);
    other.cancelInteractiveLogin();
  } finally {release();globalThis.fetch=oldFetch;other.cancelInteractiveLogin();}
}));

test('queued mutation cannot adopt an explicitly replaced credential tuple', async () => fixture(async dir => {
  const env={BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'old'};
  const manager=new AccountManager({sessionDirectory:dir});const oldFetch=globalThis.fetch;
  let entered,release,calls=0;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  try {
    globalThis.fetch=async (_url,options)=>{calls++;assert.equal(options.headers.authorization,'Bearer old');entered();await blocked;return new Response('{}');};
    const first=manager.filamentAction('delete',{ids:[1]},'device',env);await started;
    const queued=manager.filamentAction('delete',{ids:[2]},'device',env);await new Promise(r=>setImmediate(r));
    env.BAMBU_SIGNED_CLOUD_TOKEN='other';env.BAMBU_SIGNED_CLOUD_USERNAME='u_99';
    release();await first.catch(()=>{});await assert.rejects(queued,/authority changed/);assert.equal(calls,1);
  } finally {release();globalThis.fetch=oldFetch;}
}));
