import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountManager} from '../dist/account/index.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('reference capability keeps one bound account and makes one allowlisted task POST',async()=>{
 const env={BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'token'};
 const manager=new AccountManager({vendor:{request:async()=>({devices:[{dev_id:'20PTEST'}]})}});
 const oldFetch=globalThis.fetch;const requests=[];
 try {
  globalThis.fetch=async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify(options.method==='POST'?{id:99}:{id:42,deviceId:'20PTEST'}));};
  const account=await manager.beginCompletedJobAccount('20PTEST',env);
  await account.fetchTask('42');let sent=0;
  const body={mode:'auto_repeat',deviceId:'20PTEST',modelId:'m',profileId:3,instanceId:4,plateIndex:2,bedType:'textured_plate',useAms:true,isPublicProfile:false};
  assert.equal(await account.dispatch(body,{proof:'ok'},()=>sent++),'99');assert.equal(sent,1);
  await assert.rejects(account.dispatch(body,{},()=>{}),/already attempted/);
  assert.equal(requests.filter(r=>r.options.method==='POST').length,1);assert.deepEqual(JSON.parse(requests.at(-1).options.body),body);
 } finally {globalThis.fetch=oldFetch;}
});

test('account switch and arbitrary fields prevent dispatch',async()=>{
 const env={BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'token'};
 const manager=new AccountManager({vendor:{request:async()=>({devices:[{dev_id:'20PTEST'}]})}});
 const oldFetch=globalThis.fetch;let calls=0;
 try {
  globalThis.fetch=async()=>{calls++;return new Response('{}');};
  const account=await manager.beginCompletedJobAccount('20PTEST',env);
  await assert.rejects(account.dispatch({mode:'auto_repeat',deviceId:'20PTEST',url:'https://example.com'}, {},()=>{}),/Invalid completed-job reference/);
  env.BAMBU_SIGNED_CLOUD_TOKEN='other';await assert.rejects(account.dispatch({mode:'auto_repeat',deviceId:'20PTEST'}, {},()=>{}),/changed/);assert.equal(calls,0);
 } finally {globalThis.fetch=oldFetch;}
});

test('explicit tuple replacement after admission sends no binding request under the replacement',async()=>{
 const env={BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'token'};
 let calls=0;const manager=new AccountManager({vendor:{request:async()=>{calls++;return {devices:[{dev_id:'20PTEST'}]};}}});
 const original=manager.verifyAdmission.bind(manager);manager.verifyAdmission=async(...args)=>{const value=await original(...args);env.BAMBU_SIGNED_CLOUD_TOKEN='other';return value;};
 await assert.rejects(manager.beginCompletedJobAccount('20PTEST',env),/authority changed/);assert.equal(calls,0);
});

test('locked recovery rejects an account change during final binding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reference-account-'));
 const env={BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'token'};
 let calls=0,removed=false;
 const manager=new AccountManager({sessionDirectory:dir,vendor:{request:async()=>{if(++calls===2)env.BAMBU_SIGNED_CLOUD_TOKEN='other';return {devices:[{dev_id:'20PTEST'}]};}}});
 try {const account=await manager.beginCompletedJobAccount('20PTEST',env);await assert.rejects(account.withLockedAuthority(()=>{removed=true;}),/changed/);assert.equal(removed,false);}
 finally {await rm(dir,{recursive:true,force:true});}
});
