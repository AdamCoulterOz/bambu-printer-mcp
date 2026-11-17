import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCoverUrl,isPublicCoverAddress,readHistoryCover} from '../dist/account/history-media.js';
import {AccountManager} from '../dist/account/index.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import sharp from 'sharp';
import {createServer,get} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('historical cover admits only the observed HTTPS media host', () => {
  assert.equal(validateCoverUrl('https://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com/file?secret=value').hostname, 'or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com');
  assert.equal(validateCoverUrl('https://s3.us-west-2.amazonaws.com/or-cloud-model-prod/example').hostname,'s3.us-west-2.amazonaws.com');
  for (const url of ['http://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com/a', 'https://127.0.0.1/a', 'https://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com.evil.example/a', 'https://user@or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com/a', 'https://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com:444/a', 'https://s3.us-west-2.amazonaws.com/or-cloud-model-prod.evil/example', 'https://s3.us-west-2.amazonaws.com/or-cloud-model-prod/../different/example']) assert.throws(() => validateCoverUrl(url), /Historical cover unavailable/);
});

test('native HTTPS lookup connects over pinned IPv4 with normal TLS verification', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bambu-cover-tls-'));
  let server;
  try {
    const host='or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com';
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host}`,'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
    const key=await readFile(join(dir,'key.pem')),cert=await readFile(join(dir,'cert.pem'));
    const png=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
    server=createServer({key,cert},(_req,res)=>{res.writeHead(200,{'content-type':'image/png'});res.end(png);});
    await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=server.address().port;let observed;
    const request=(url,options,callback)=>get(url,{...options,port,ca:cert,lookup:(host,lookupOptions,done)=>{
      observed=lookupOptions;
      options.lookup(host,lookupOptions,(err,address,family)=>{assert.ifError(err);assert.equal(address,'8.8.8.8');assert.equal(family,4);done(null,'127.0.0.1',4);});
    }},callback);
    const result=await readHistoryCover(`https://${host}/fixture`,undefined,{resolve:async()=>[{address:'8.8.8.8',family:4}],request});
    assert.equal(observed.family,4);assert.notEqual(observed.all,true);assert.deepEqual(result.bytes,png);
  } finally { if(server) await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true}); }
});

test('DNS pinning rejects nonpublic, mapped, malformed, and documentation addresses', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','198.51.100.1','::1','::ffff:127.0.0.1','1.2.3.999']) assert.equal(isPublicCoverAddress(ip),false,ip);
  assert.equal(isPublicCoverAddress('8.8.8.8'),true);
});

test('task ownership is verified before any cover is requested', async () => {
  const env = {BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883', BAMBU_SIGNED_CLOUD_USERNAME:'u_123', BAMBU_SIGNED_CLOUD_TOKEN:'token'};
  const manager = new AccountManager({vendor:{request:async () => ({devices:[{dev_id:'device123'}]})}});
  const original = globalThis.fetch;
  let calls=0;
  try {
    globalThis.fetch = async () => {calls++; return new Response(JSON.stringify({id:42,deviceId:'other',cover:'https://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com/private'}));};
    await assert.rejects(manager.cloudPrintHistoryCover('device123',42,env), /does not belong/);
    assert.equal(calls,1);
  } finally { globalThis.fetch = original; }
});

test('cover uses pinned public DNS, rejects redirects and validates complete image', async () => {
  const url='https://or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com/x?secret=hidden';
  const png=await sharp({create:{width:2,height:2,channels:3,background:'#ff0000'}}).png().toBuffer();
  let requests=0;
  const requestFor=(status,bytes)=> (_url,options,callback)=>{
    requests++;
    options.lookup('ignored',{},(_error,ip,family)=>{assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
    assert.equal(options.agent,false);
    const request=new EventEmitter();
    queueMicrotask(()=>{const response=new PassThrough();response.statusCode=status;response.headers={};callback(response);response.end(bytes);});
    return request;
  };
  const resolve=async()=>[{address:'8.8.8.8',family:4}];
  const result=await readHistoryCover(url,undefined,{resolve,request:requestFor(200,png)});
  assert.equal(result.mimeType,'image/png');assert.deepEqual(result.bytes,png);
  await assert.rejects(readHistoryCover(url,undefined,{resolve,request:requestFor(302,Buffer.alloc(0))}),/unavailable/);
  await assert.rejects(readHistoryCover(url,undefined,{resolve,request:requestFor(200,Buffer.from('not an image'))}),/unavailable/);
  const before=requests;
  await assert.rejects(readHistoryCover(url,undefined,{resolve:async()=>[{address:'127.0.0.1',family:4}],request:requestFor(200,png)}),/unavailable/);
  assert.equal(requests,before);
});
