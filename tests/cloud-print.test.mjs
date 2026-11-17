import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { submitCloudPrint } from '../dist/cloud-print.js';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-print-test-'));
  const file = await readFile(new URL('./fixtures/studio-02.08.02.61/two-plates-three-filaments-sliced.3mf',import.meta.url)); const filePath = join(dir,'snapshot.3mf'); await writeFile(filePath,file);
  const events = [], requests = [];
  const answers = [{project_id:'1',model_id:'2',profile_id:'3',upload_ticket:'4',upload_url:'https://s3.amazonaws.com/bucket/config?signature=secret'}, {}, {}, {message:'success'}, {urls:[{url:'https://s3.amazonaws.com/bucket/model?signature=secret'}]}, {}, {}, {id:'987'}];
  const options = {api:'https://api.bambulab.com', token:'fake',username:'u_123', signingDirectory:'/unused',filePath,sha256:createHash('sha256').update(file).digest('hex'),filename:'checked.3mf',plate:2,task:{deviceId:'PRINTER',amsMapping:[1]}, proofFactory:async()=>{events.push('proof');return {'x-bbl-device-security-sign':'proof'};},beforeDispatch:async()=>events.push('preflight'),onDispatch:()=>events.push('dispatch'),fetcher:async(url,init)=>{requests.push({url,init}); events.push(new URL(url).pathname); return new Response(JSON.stringify(answers.shift()), {status:200,headers:{'content-type':'application/json'}});}};
  try { await run(options,events,requests); } finally { await rm(dir,{recursive:true,force:true}); }
}
test('cloud submission checks before single task dispatch, preserving inspected plate',async()=>fixture(async(o,events,requests)=>{
  const result=await submitCloudPrint(o); assert.equal(result.taskId,'987'); assert.equal(result.dispatch,'unconfirmed');
  assert.deepEqual(events.slice(-4), ['proof','preflight','dispatch','/v1/user-service/my/task']);
  assert.equal(requests.filter(r=>r.url.endsWith('/my/task')).length,1);
  const task=JSON.parse(requests.at(-1).init.body); assert.equal(task.plateIndex,2); assert.equal(task.mode,'cloud_file'); assert.deepEqual(task.amsMapping,[1]);
  assert.equal(requests[1].init.headers,undefined); assert.equal(requests[5].init.headers,undefined);
  assert.equal(result.cover_source,'selected_plate_config'); assert.equal(result.cover_processing,'unconfirmed');
  const config=await JSZip.loadAsync(requests[1].init.body), original=await readFile(o.filePath), source=await JSZip.loadAsync(original);
  assert.deepEqual(Buffer.from(requests[5].init.body),original);
  assert.notDeepEqual(Buffer.from(requests[1].init.body),original);
  assert.deepEqual(await config.file('Metadata/plate_2.png').async('nodebuffer'),await source.file('Metadata/plate_2.png').async('nodebuffer'));
  assert.equal(config.file('Metadata/plate_1.png'),null); assert.equal(config.file('Metadata/plate_2.gcode'),null);
  assert.match(await config.file('_rels/.rels').async('string'),/plate_2\.png/);
}));
test('fresh preflight failure prevents final task dispatch',async()=>fixture(async(o,events,requests)=>{
  o.beforeDispatch=async()=>{throw Error('printer changed');};
  await assert.rejects(submitCloudPrint(o),/printer changed/); assert.equal(requests.some(r=>r.url.endsWith('/my/task')),false); assert.equal(events.includes('dispatch'),false);
}));
test('unknown dispatch outcome never replays and does not expose tokens',async()=>fixture(async(o,events,requests)=>{
  const mock=o.fetcher; o.fetcher=async(url,init)=>{if(url.endsWith('/my/task')) {requests.push({url,init}); throw Error('secret url');} return mock(url,init);};
  await assert.rejects(submitCloudPrint(o),e=>/uncertain/.test(e.message) && !e.message.includes('secret'));
  assert.equal(requests.filter(r=>r.url.endsWith('/my/task')).length,1); assert.equal(events.filter(e=>e==='dispatch').length,1);
}));
test('snapshot mismatch prevents cloud writes',async()=>fixture(async(o,events,requests)=>{
  o.sha256='0'.repeat(64); await assert.rejects(submitCloudPrint(o),/changed/); assert.equal(requests.length,0);
}));
test('rejects logical vendor errors and untrusted presigned URLs',async()=>fixture(async(o,events,requests)=>{
  o.fetcher=async()=>new Response(JSON.stringify({code:9}),{status:200}); await assert.rejects(submitCloudPrint(o),/Invalid cloud write response/);
  o.fetcher=async()=>new Response(JSON.stringify({project_id:'1',model_id:'2',profile_id:'3',upload_ticket:'4',upload_url:'http://127.0.0.1/'}),{status:200}); await assert.rejects(submitCloudPrint(o),/Untrusted cloud upload URL/);
}));

test('Handy identity is private, persistent, and scoped to the application state directory',async()=>{
  const { handyClientHeaders }=await import('../dist/signing/http-proof.js');
  const dir=await mkdtemp(join(tmpdir(),'handy-identity-test-'));
  try {
    const a=await handyClientHeaders(dir,'14'), b=await handyClientHeaders(dir,'14');
    assert.equal(a['x-bbl-device-id'],b['x-bbl-device-id']); assert.match(a['x-bbl-device-id'],/^[a-f0-9-]{36}$/);
    assert.equal(a['x-bbl-client-name'],'BambuHandy'); assert.equal(a['x-bbl-os-type'],'android');
    assert.equal(a['x-bbl-device-brand'],'headless-runtime');
    await assert.rejects(handyClientHeaders(dir,''));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('preserves a large numeric task ID exactly',async()=>fixture(async(o)=>{
  const mock=o.fetcher; o.fetcher=async(url,init)=>url.endsWith('/my/task') ? new Response('{"id":9223372036854775807}',{status:200}) : mock(url,init);
  const receipt=await submitCloudPrint(o); assert.equal(receipt.taskId,'9223372036854775807');
}));

test('HTTP proof renewal is opt-in, directory-bound and fails before proof for missing managed source', async () => {
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHttpProof, httpProofRenewalConfiguration } = await import('../dist/signing/http-proof.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'proof-renew-test-')));
  try {
    assert.equal(httpProofRenewalConfiguration({}, dir), undefined);
    assert.throws(() => httpProofRenewalConfiguration({BAMBU_SIGNING_AUTO_RENEW:'true'}, dir), /SIGNING_CONFIGURATION_INVALID/);
    assert.throws(() => httpProofRenewalConfiguration({BAMBU_SIGNING_AUTO_RENEW:'true',BAMBU_SIGNING_REGION:'global',BAMBU_SIGNING_BOOTSTRAP_FILE:'/source'}, dir), /SIGNING_CONFIGURATION_INVALID/);
    const automatic = httpProofRenewalConfiguration({BAMBU_SIGNING_AUTO_RENEW:'true',BAMBU_SIGNING_REGION:'global'}, dir);
    await assert.rejects(createHttpProof(dir, undefined, {...automatic,directory:dir+'/other'}), /SIGNING_CONFIGURATION_INVALID/);
    await assert.rejects(createHttpProof(dir), error => error.code === 'ENOENT');
    await assert.rejects(createHttpProof(dir, undefined, automatic), /SIGNING_MANAGED_SOURCE_UNAVAILABLE/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('missing selected plate preview stops before any cloud request',async()=>fixture(async(o,events,requests)=>{
  const archive=await JSZip.loadAsync(await readFile(o.filePath)); archive.remove('Metadata/plate_2.png');
  const changed=await archive.generateAsync({type:'nodebuffer'});await writeFile(o.filePath,changed);o.sha256=createHash('sha256').update(changed).digest('hex');
  await assert.rejects(submitCloudPrint(o),/selected-plate preview/);assert.equal(requests.length,0);assert.equal(events.includes('dispatch'),false);
}));

test('malformed selected metadata stops before any cloud project',async()=>fixture(async(o,events,requests)=>{
  const archive=await JSZip.loadAsync(await readFile(o.filePath));archive.file('Metadata/slice_info.config','<!DOCTYPE config [<!ENTITY x "bad">]><config/>');
  const changed=await archive.generateAsync({type:'nodebuffer'});await writeFile(o.filePath,changed);o.sha256=createHash('sha256').update(changed).digest('hex');
  await assert.rejects(submitCloudPrint(o),/selected-plate preview/);assert.equal(requests.length,0);assert.equal(events.includes('dispatch'),false);
}));
