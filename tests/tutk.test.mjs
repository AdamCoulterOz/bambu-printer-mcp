import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runTutkOperation} from '../dist/tutk.js';
const dir=mkdtempSync(join(tmpdir(),'tutk-direct-test-')),lockFile=join(dir,'lock');writeFileSync(lockFile,'',{mode:0o600});process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
const jpeg=Buffer.from([255,216,255,217]);
function setup(){
 const calls=[],credentials={url:'mqtts://us.mqtt.bambulab.com:8883',username:'u_1',password:'private-token',assertCurrent:async()=>{},assertGenerationCurrent:()=>{}};
 const options={serial:'SERIAL',signingDirectory:'/unused',stateDirectory:'/unused',osVersion:'14',lockFile,operation:{operation:'camera'}};
 const deps={credentials:async()=>credentials,proof:async()=>({proof:'test'}),headers:async()=>({identity:'test'}),fetch:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ttcode:'uid',authkey:'key',passwd:'pass',region:'us',type:'tutk'}),{status:200})},execute:async(request)=>{calls.push({request});return {kind:'camera',jpeg}}};
 return {calls,options,deps};
}
test('one ticket then direct transport without MQTT or helper HTTP',async()=>{
 const {calls,options,deps}=setup();const result=await runTutkOperation(options,deps);assert.deepEqual(result,{kind:'camera',jpeg});assert.equal(calls.length,2);assert.equal(new URL(calls[0].url).pathname,'/v1/iot-service/api/user/ttcode');assert.deepEqual(JSON.parse(calls[0].init.body),{dev_id:'SERIAL',protocols:['tutk']});assert.deepEqual(calls[1].request.session,{uid:'uid',authkey:'key',passwd:'pass',region:'us',device:'SERIAL'});
});
test('rejected ticket is not retried and never opens direct transport',async()=>{
 const {calls,options,deps}=setup();deps.fetch=async()=>{calls.push('mint');return new Response('{}',{status:403})};await assert.rejects(runTutkOperation(options,deps),e=>e.code==='REMOTE_MEDIA_TICKET');assert.deepEqual(calls,['mint']);
});
test('shared lock remains held during cancellation until direct transport closes',async()=>{
 const first=setup(), second=setup(), abort=new AbortController();first.options.signal=abort.signal;let entered,allowClose,started=false;const ready=new Promise(r=>entered=r);
 first.deps.execute=async(_request,signal)=>{entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await new Promise(resolve=>allowClose=resolve);return {kind:'camera',jpeg}};
 second.deps.fetch=async(...args)=>{started=true;return new Response(JSON.stringify({ttcode:'uid',authkey:'key',passwd:'pass',region:'us'}))};
 const pending=runTutkOperation(first.options,first.deps);const caught=assert.rejects(pending,e=>e.code==='REMOTE_MEDIA_DIRECT');await ready;abort.abort();const competing=runTutkOperation(second.options,second.deps);await new Promise(r=>setTimeout(r,100));assert.equal(started,false);allowClose();await caught;await competing;assert.equal(started,true);
});
test('normalized results enforce shape, checksum and allowlisted metadata',async()=>{
 const c=setup();c.options.operation={operation:'list',kind:'model',storage:'emmc'};c.deps.execute=async()=>({kind:'list',files:[{type:'model',name:'example.3mf',path:'/synthetic/example.3mf',secret:'hidden'}]});assert.deepEqual(await runTutkOperation(c.options,c.deps),{kind:'list',files:[{type:'model',name:'example.3mf',path:'/synthetic/example.3mf'}]});
 const d=setup();d.options.operation={operation:'download',path:'/synthetic/example'};d.deps.execute=async()=>({kind:'download',bytes:Buffer.from('abc'),size:3,md5:'900150983cd24fb0d6963f7d28e17f72'});assert.equal((await runTutkOperation(d.options,d.deps)).size,3);d.deps.execute=async()=>({kind:'download',bytes:Buffer.from('abc'),size:3,md5:'0'.repeat(32)});await assert.rejects(runTutkOperation(d.options,d.deps),e=>e.code==='REMOTE_MEDIA_VALIDATION');
});
test('failure stages are sanitized and EU route remains scoped',async()=>{
 const a=setup();a.deps.credentials=async()=>{throw Error('secret url token')};await assert.rejects(runTutkOperation(a.options,a.deps),e=>e.code==='REMOTE_MEDIA_ACCOUNT'&&!String(e).includes('secret'));
 const b=setup(),original=b.deps.credentials;b.deps.credentials=async s=>({...await original(s),url:'mqtts://eu.mqtt.bambulab.com:8883'});await runTutkOperation(b.options,b.deps);assert.equal(new URL(b.calls[0].url).hostname,'api.bambulab.com');
});
test('account authority change aborts direct transport before it settles',async()=>{
 const c=setup();let generationValid=true,entered;const ready=new Promise(r=>entered=r);const original=c.deps.credentials;
 c.deps.credentials=async s=>({...await original(s),assertGenerationCurrent:()=>{if(!generationValid)throw Error('changed')}});
 c.deps.execute=async(_request,signal)=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {kind:'camera',jpeg}};
 const pending=runTutkOperation(c.options,c.deps);const caught=assert.rejects(pending,e=>e.code==='REMOTE_MEDIA_DIRECT');await ready;generationValid=false;await caught;
});
test('logical ticket error cannot start direct transport',async()=>{const c=setup();let opened=false;c.deps.fetch=async()=>new Response(JSON.stringify({code:8,ttcode:'uid',authkey:'key',passwd:'pass',region:'us'}));c.deps.execute=async()=>{opened=true;return {kind:'camera',jpeg}};await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.code==='REMOTE_MEDIA_TICKET');assert.equal(opened,false);});
test('archive producer uses one checked download and rejects corrupted file digest',async()=>{
 const {runRemoteArchive}=await import('../dist/tutk.js');const JSZip=(await import('jszip')).default;const {createHash}=await import('node:crypto');
 const zip=new JSZip();zip.file('Metadata/plate_1.png','preview');const bytes=await zip.generateAsync({type:'nodebuffer'}),c=setup();
 c.deps.execute=async request=>{assert.equal(request.operation,'download');return {kind:'download',bytes,size:bytes.length,md5:createHash('md5').update(bytes).digest('hex')}};
 const {operation,...base}=c.options;const out=await runRemoteArchive({...base,path:'/example.3mf',member:'Metadata/plate_1.png'},c.deps);assert.equal(out.bytes.toString(),'preview');
 c.deps.execute=async()=>({kind:'download',bytes,size:bytes.length,md5:'0'.repeat(32)});await assert.rejects(runRemoteArchive({...base,path:'/example.3mf'},c.deps));
});
test('delete preserves typed uncertain receipt and does not retry after possible handoff',async()=>{
 const {MutationFailure}=await import('../dist/tutk-direct/mutations.js');const c=setup();c.options.operation={operation:'delete',path:'/userdata/model/a.3mf',confirm:true,kind:'model',storage:'emmc'};let calls=0;
 c.deps.execute=async()=>{calls++;throw new MutationFailure({status:'unknown',operation:'delete',path:'/userdata/model/a.3mf',retryable:false})};
 await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.receipt?.status==='unknown'&&e.receipt.retryable===false);assert.equal(calls,1);assert.equal(c.calls.length,1);
 c.deps.execute=async()=>({kind:'delete',receipt:{status:'acknowledged',operation:'delete',path:'/userdata/model/a.3mf',retryable:false}});
 assert.equal((await runTutkOperation(c.options,c.deps)).receipt.status,'acknowledged');
});
test('delete cancellation retains lock until direct cleanup and reports unknown',async()=>{
 const c=setup(),next=setup(),abort=new AbortController();let ready,release,entered;const started=new Promise(r=>ready=r);
 c.options.signal=abort.signal;c.options.operation={operation:'delete',path:'/userdata/model/a.3mf',confirm:true,kind:'model',storage:'emmc'};
 c.deps.execute=async(request,signal)=>{await request.onHandoff();ready();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await new Promise(r=>release=r);throw Error('cancelled')};
 next.deps.fetch=async()=>{entered=true;return new Response(JSON.stringify({ttcode:'uid',authkey:'key',passwd:'pass',region:'us'}))};
 const work=runTutkOperation(c.options,c.deps),failed=assert.rejects(work,e=>e.receipt?.status==='unknown'&&e.receipt.retryable===false);await started;abort.abort();const competing=runTutkOperation(next.options,next.deps);await new Promise(r=>setTimeout(r,100));assert.equal(entered,undefined);release();await failed;await competing;assert.equal(entered,true);
});
test('upload producer binds unique snapshot and checks returned identity',async()=>{
 const c=setup();c.options.operation={operation:'upload',bytes:Buffer.from('abc'),name:'fixture.3mf',storage:'emmc',allowHistoryRotation:true};
 c.deps.execute=async request=>{await request.onHandoff();request.onUploadAck();const j=request.job;return {kind:'upload',receipt:{status:'verified',operation:'upload',path:j.remoteName,retryable:false,sha256:j.sha256,md5:j.md5,size:j.size},actualPath:'/userdata/model/history/'+j.remoteName}};
 const result=await runTutkOperation(c.options,c.deps);assert.equal(result.receipt.status,'verified');assert.match(result.actualPath,/fixture-[a-f0-9]{32}\.3mf$/);
});
test('upload producer reports not_sent, unknown and post-ACK unverified without replay',async()=>{
 const c=setup();c.options.operation={operation:'upload',bytes:Buffer.from('abc'),name:'fixture.3mf',storage:'emmc',allowHistoryRotation:false};
 await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.receipt?.status==='not_sent');assert.equal(c.calls.length,0);
 c.options.operation.allowHistoryRotation=true;let count=0;c.deps.execute=async request=>{count++;await request.onHandoff();throw Error('timeout')};
 await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.receipt?.status==='unknown'&&e.receipt.retryable===false);assert.equal(count,1);
 c.deps.execute=async request=>{await request.onHandoff();request.onUploadAck();throw Error('readback failed')};
 await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.receipt?.status==='uploaded_unverified'&&e.receipt.reason==='readback_failed');
});
test('mutation authority is rechecked synchronously before handoff',async()=>{
 const c=setup(),original=c.deps.credentials;let valid=true;c.options.operation={operation:'delete',path:'/userdata/model/a.3mf',confirm:true,kind:'model',storage:'emmc'};
 c.deps.credentials=async s=>({...await original(s),assertGenerationCurrent:()=>{if(!valid)throw Error('changed')}});
 c.deps.execute=async request=>{valid=false;await request.onHandoff();throw Error('unreachable')};
 await assert.rejects(runTutkOperation(c.options,c.deps),e=>e.receipt?.status==='not_sent');
});
test('lock helper death cannot release inherited flock until mutation cleanup settles',async()=>{
 const c=setup(),other=setup();let pid,entered,release,competing=false;const ready=new Promise(r=>entered=r);
 c.options.operation={operation:'delete',path:'/userdata/model/a.3mf',confirm:true,kind:'model',storage:'emmc'};c.deps.onLockChild=p=>pid=p;
 c.deps.execute=async(request,signal)=>{await request.onHandoff();entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await new Promise(r=>release=r);throw Error('closed')};
 other.deps.fetch=async()=>{competing=true;return new Response(JSON.stringify({ttcode:'uid',authkey:'key',passwd:'pass',region:'us'}))};
 const work=runTutkOperation(c.options,c.deps),failed=assert.rejects(work,e=>e.receipt?.status==='unknown');await ready;process.kill(pid,'SIGKILL');
 const next=runTutkOperation(other.options,other.deps);await new Promise(r=>setTimeout(r,150));assert.equal(competing,false);release();await failed;await next;assert.equal(competing,true);
});
test('durable credential revocation while AV login is paused yields not_sent',async()=>{
 const c=setup(),base=c.deps.credentials;let valid=true,enter,release,sent=0;const ready=new Promise(r=>enter=r);
 c.options.operation={operation:'delete',path:'/userdata/model/a.3mf',confirm:true,kind:'model',storage:'emmc'};
 c.deps.credentials=async s=>({...await base(s),assertCurrent:async()=>{if(!valid)throw Error('revoked')}});
 c.deps.execute=async request=>{enter();await new Promise(r=>release=r);await request.assertAuthority();request.assertAuthoritySync();request.onHandoff();sent++;throw Error('unexpected')};
 const work=runTutkOperation(c.options,c.deps),failure=assert.rejects(work,e=>e.receipt?.status==='not_sent');await ready;valid=false;release();await failure;assert.equal(sent,0);
});
test('durable credential revocation between upload chunks yields unknown and no later packet',async()=>{
 const c=setup(),base=c.deps.credentials;let valid=true,enter,release,sent=0;const ready=new Promise(r=>enter=r);
 c.options.operation={operation:'upload',bytes:Buffer.from('abc'),name:'fixture.3mf',storage:'emmc',allowHistoryRotation:true};
 c.deps.credentials=async s=>({...await base(s),assertCurrent:async()=>{if(!valid)throw Error('revoked')}});
 c.deps.execute=async request=>{await request.assertAuthority();request.assertAuthoritySync();request.onHandoff();sent++;enter();await new Promise(r=>release=r);await request.assertAuthority();request.assertAuthoritySync();sent++;throw Error('unexpected')};
 const work=runTutkOperation(c.options,c.deps),failure=assert.rejects(work,e=>e.receipt?.status==='unknown');await ready;valid=false;release();await failure;assert.equal(sent,1);
});
