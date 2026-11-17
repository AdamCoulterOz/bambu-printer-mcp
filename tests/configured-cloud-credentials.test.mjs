import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountManager } from '../dist/account/index.js';

function config(host='us.mqtt.bambulab.com') {
  return {
    BAMBU_SIGNED_CLOUD_BROKER: `mqtts://${host}:8883`,
    BAMBU_SIGNED_CLOUD_USERNAME: 'u_12345',
    BAMBU_SIGNED_CLOUD_TOKEN: 'private-test-token',
  };
}
async function setup(t, request) {
  const directory=await mkdtemp(join(tmpdir(),'configured-cloud-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,manager:new AccountManager({sessionDirectory:directory,vendor:{request}})};
}
test('explicit credentials take precedence and validate the bound device for each supported region',async t=>{
  const calls=[];
  const {directory,manager}=await setup(t,async (...args)=>{
    calls.push(args);
    return {devices:[{dev_id:'SERIAL'}]};
  });
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,region:'china',token:'other-session',expiresAt:null}),{mode:0o600});
  for (const [host,region] of [['us.mqtt.bambulab.com','global'],['eu.mqtt.bambulab.com','global'],['cn.mqtt.bambulab.com','china']]) {
    const env=config(host);
    const value=await manager.getConfiguredCloudMqttCredentials('SERIAL',env);
    assert.equal(value.url,`mqtts://${host}:8883`);
    assert.equal(value.username,'u_12345');
    assert.equal(value.password,env.BAMBU_SIGNED_CLOUD_TOKEN);
    await value.assertCurrent();
    value.assertGenerationCurrent();
    assert.equal(calls.at(-1)[0],region);
    assert.equal(calls.at(-1)[1],'/v1/iot-service/api/user/bind');
    assert.equal(calls.at(-1)[3],env.BAMBU_SIGNED_CLOUD_TOKEN);
  }
  await manager.logout();
  const afterLogout=await manager.getConfiguredCloudMqttCredentials('SERIAL',config());
  await afterLogout.assertCurrent();
});

test('partial tuples and unsupported brokers fail before the network call',async t=>{
  let calls=0;
  const {manager}=await setup(t,async ()=>{calls++;return {devices:[{dev_id:'SERIAL'}]}});
  await assert.rejects(manager.getConfiguredCloudMqttCredentials('SERIAL',{BAMBU_SIGNED_CLOUD_TOKEN:'token'}),/incomplete/);
  for (const url of ['mqtts://us.mqtt.bambulab.com:8884','mqtt://us.mqtt.bambulab.com:8883','mqtts://bad.example:8883','mqtts://us.mqtt.bambulab.com:8883/path','mqtts://user@us.mqtt.bambulab.com:8883']) {
    await assert.rejects(manager.getConfiguredCloudMqttCredentials('SERIAL',{...config(),BAMBU_SIGNED_CLOUD_BROKER:url}),/invalid/);
  }
  await assert.rejects(manager.getConfiguredCloudMqttCredentials('SERIAL',{...config(),BAMBU_SIGNED_CLOUD_USERNAME:'user'}),/invalid/);
  assert.equal(calls,0);
});
test('binding must be exact and unique, and vendor errors are sanitized',async t=>{
  for (const devices of [[],[{dev_id:'WRONG'}],[{dev_id:'SERIAL'},{dev_id:'SERIAL'}]]) {
    const {manager}=await setup(t,async ()=>({devices}));
    await assert.rejects(manager.getConfiguredCloudMqttCredentials('SERIAL',config()),/not uniquely bound/);
  }
  const {manager}=await setup(t,async ()=>{throw new Error('private-test-token')});
  await assert.rejects(manager.getConfiguredCloudMqttCredentials('SERIAL',config()),err=>!err.message.includes('private-test-token') && /binding request failed/.test(err.message));
});
test('changing explicit configuration during binding or afterward revokes returned credentials',async t=>{
  let finish, started;
  const startedPromise=new Promise(resolve=>{started=resolve});
  const {manager}=await setup(t,async ()=>{
    started();
    await new Promise(resolve=>{finish=resolve});
    return {devices:[{dev_id:'SERIAL'}]};
  });
  const env=config();
  const pending=manager.getConfiguredCloudMqttCredentials('SERIAL',env);
  await startedPromise;
  env.BAMBU_SIGNED_CLOUD_TOKEN='changed';
  finish();
  await assert.rejects(pending,/configuration changed/);

  const readySetup=await setup(t,async ()=>({devices:[{dev_id:'SERIAL'}]}));
  const readyEnv=config();
  const ready=await readySetup.manager.getConfiguredCloudMqttCredentials('SERIAL',readyEnv);
  readyEnv.BAMBU_SIGNED_CLOUD_BROKER='mqtts://eu.mqtt.bambulab.com:8883';
  assert.throws(()=>ready.assertGenerationCurrent(),/configuration changed/);
  await assert.rejects(ready.assertCurrent(),/configuration changed/);
});
test('missing explicit tuple delegates to cached account credentials and detects configuration transition',async t=>{
  const {directory,manager}=await setup(t,async (_region,path)=>{
    if (path.endsWith('/bind')) return {devices:[{dev_id:'SERIAL'}]};
    return {uid:99};
  });
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,region:'global',token:'existing-session',expiresAt:null}),{mode:0o600});
  const env={};
  const value=await manager.getConfiguredCloudMqttCredentials('SERIAL',env);
  assert.equal(value.username,'u_99');
  await value.assertCurrent();
  env.BAMBU_SIGNED_CLOUD_TOKEN='token';
  assert.throws(()=>value.assertGenerationCurrent(),/configuration changed/);
  await assert.rejects(value.assertCurrent(),/configuration changed/);
});
test('cancellation during binding prevents an authorized result',async t=>{
  let finish, started;
  const begun=new Promise(resolve=>{started=resolve});
  const {manager}=await setup(t,async ()=>{
    started();
    await new Promise(resolve=>{finish=resolve});
    return {devices:[{dev_id:'SERIAL'}]};
  });
  const abort=new AbortController();
  const pending=manager.getConfiguredCloudMqttCredentials('SERIAL',config(),abort.signal);
  await begun;
  abort.abort();
  finish();
  await assert.rejects(pending,/cancelled/);
});
