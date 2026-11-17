import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeReferenceReprint,ReferenceDispatchUnknown,referenceRequirements} from '../dist/account/reference-dispatch.js';
import {BambuImplementation} from '../dist/printers/bambu.js';

function fixture() {
 const serial='20PTEST', task={id:'42',deviceId:serial,status:2,isPrintable:true,isDelete:false,mode:'cloud_file',modelId:'m',profileId:456,instanceId:789,plateIndex:2,deviceModel:'X2D',bedType:'textured_plate',useAms:true,isPublicProfile:false,amsMapping:[-1,1,128,-1,-1],amsMapping2:[{amsId:255,slotId:255},{amsId:0,slotId:1},{amsId:128,slotId:0},{amsId:255,slotId:255},{amsId:255,slotId:255}],amsDetailMapping:[{ams:1,nozzleId:1,amsId:0,slotId:1},{ams:128,nozzleId:0,amsId:128,slotId:0}]};
 const profile={profileId:456,modelId:'m',extention:{modelInfo:{plates:[{index:2,nozzleDiameters:[0.4,0.4],filaments:[{id:'2',type:'PETG'},{id:'3',type:'PLA'}]}]}}};
 const report={model:'x2d',gcode_state:'IDLE',nozzle_diameter:['0.4','0.4'],print_error:0,hms:[],ams:{tray_exist_bits:'2',ams:[{id:'0',tray:[{id:'1',tray_type:'PETG'}]},{id:'128',tray_exist_bits:'1',tray:[{id:'0',tray_type:'PLA'}]}]}};
 const printer=new BambuImplementation(async()=>true);let posts=0,reads=0,confirmed=0,stale=false,active=true;
 const account={fetchTask:async()=>structuredClone(task),fetchProfile:async()=>structuredClone(profile),assertCurrent:async()=>{if(stale)throw Error('account authority changed');},dispatch:async(payload,_headers,on)=>{posts++;on();return '99';}};
 const execution={account,serial,taskId:'42',assertActive:()=>{if(!active)throw Error('cancelled');},readStatus:async()=>{reads++;return {connected:true,serial,raw:structuredClone(report),observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now()}};},confirm:async(status,ref)=>{confirmed++;return printer.confirmCompletedJobReferencePreflight(serial,status,{sourceTaskId:ref.sourceTaskId,model:ref.declared.deviceModel,nozzles:ref.declared.nozzleDiameters,materials:ref.declared.materials.map(m=>m.type)});},assertPreflight:(s,p)=>printer.assertPrintPreflight(s,p),headers:async()=>({proof:'fixture'}),prepareHandoff:()=> 'nonce',discardHandoff:()=>{},onDispatch:()=>{},onAccepted:()=>{}};
 return {task,profile,report,account,execution,counts:()=>({posts,reads,confirmed}),setStale:()=>{stale=true;},cancel:()=>{active=false;}};
}

test('completed reference uses global filament positions and makes exactly one dispatch',async()=>{
 const f=fixture();let body;const dispatch=f.account.dispatch;f.account.dispatch=async(p,h,on)=>{body=p;return dispatch(p,h,on);};
 const result=await executeReferenceReprint(f.execution);
 assert.equal(result.verification,'provider_completed_job_reference');assert.equal(result.dispatch,'unconfirmed');assert.equal(result.newTaskId,'99');assert.equal(f.counts().posts,1);assert.equal(f.counts().reads,3);assert.equal(f.counts().confirmed,1);
 assert.equal(body.mode,'auto_repeat');assert.deepEqual(body.amsMapping,[-1,1,128,-1,-1]);assert.equal(body.deviceId,'20PTEST');assert.ok(!JSON.stringify(body).includes('gcode'));
});

test('external holder accepts a fresh declared material without claiming RFID occupancy, with physical confirmation',async()=>{
 const f=fixture();f.task.useAms=false;f.task.amsMapping=[255];f.task.amsMapping2=[{amsId:255,slotId:0}];f.task.amsDetailMapping=[{ams:255,amsId:255,slotId:0,nozzleId:0}];
 f.profile.extention.modelInfo.plates[0].filaments=[{id:'1',type:'PLA'}];
 f.report.vir_slot=[{id:255,tray_type:'PLA'}];delete f.report.ams;
 const result=await executeReferenceReprint(f.execution);assert.equal(result.dispatch,'unconfirmed');assert.equal(f.counts().confirmed,1);assert.equal(f.counts().posts,1);
});

for(const [name,change] of [
 ['nozzle mismatch',f=>f.report.nozzle_diameter=['0.8','0.4']],
 ['missing material',f=>delete f.report.ams.ams[0].tray[0].tray_type],
 ['known empty with stale label',f=>f.report.ams.tray_exist_bits='0'],
 ['explicit empty state despite occupied mask',f=>f.report.ams.ams[0].tray[0].state=0],
 ['no occupancy evidence',f=>delete f.report.ams.tray_exist_bits],
 ['duplicate unit',f=>f.report.ams.ams.push(structuredClone(f.report.ams.ams[0]))],
 ['duplicate tray',f=>f.report.ams.ams[0].tray.push(structuredClone(f.report.ams.ams[0].tray[0]))],
 ['material mismatch',f=>f.report.ams.ams[0].tray[0].tray_type='ABS'],
 ['not successful',f=>f.task.status=3],
 ['account changed',f=>f.setStale()],
 ['cancelled',f=>f.cancel()],
]) test(`${name} refuses without dispatch`,async()=>{const f=fixture();change(f);await assert.rejects(executeReferenceReprint(f.execution));assert.equal(f.counts().posts,0);});

test('a changed provider profile before dispatch refuses',async()=>{
 const f=fixture(),original=f.execution.headers;f.execution.headers=async()=>{f.profile.extention.modelInfo.plates[0].filaments[0].type='ABS';return original();};
 await assert.rejects(executeReferenceReprint(f.execution),/requires_original_file/);assert.equal(f.counts().posts,0);
});

test('a lost dispatch reply returns an unknown reference receipt',async()=>{
 const f=fixture();f.account.dispatch=async(_p,_h,on)=>{on();throw Error('lost');};
 await assert.rejects(executeReferenceReprint(f.execution),e=>e instanceof ReferenceDispatchUnknown&&e.receipt.dispatch==='unknown'&&e.receipt.sourceTaskId==='42');
});

test('a fresh material change before dispatch is rejected',async()=>{
 const f=fixture(),read=f.execution.readStatus;let count=0;
 f.execution.readStatus=async()=>{if(++count===3)f.report.ams.ams[0].tray[0].tray_type='ABS';return read();};
 await assert.rejects(executeReferenceReprint(f.execution),/material/i);assert.equal(f.counts().posts,0);
});
test('fresh telemetry error and a declined physical confirmation do not dispatch',async()=>{
 const first=fixture();first.execution.readStatus=async()=>{throw Error('telemetry unavailable');};await assert.rejects(executeReferenceReprint(first.execution),/telemetry/);assert.equal(first.counts().posts,0);
 const second=fixture();second.execution.confirm=async()=>{throw Error('confirmation declined');};await assert.rejects(executeReferenceReprint(second.execution),/declined/);assert.equal(second.counts().posts,0);
});
test('cancellation after confirmation prevents any dispatch',async()=>{
 const f=fixture(),controller=new AbortController(),confirm=f.execution.confirm;f.execution.signal=controller.signal;
 f.execution.confirm=async(...args)=>{const value=await confirm(...args);controller.abort();return value;};
 await assert.rejects(executeReferenceReprint(f.execution));assert.equal(f.counts().posts,0);
});
test('a report that becomes stale while the durable handoff marker is written is rejected before POST',async()=>{
 const f=fixture(),read=f.execution.readStatus;let latest,discarded=false;
 f.execution.readStatus=async()=>latest=await read();
 f.execution.prepareHandoff=()=>{latest.observation.requestedAt=Date.now()-200000;return 'nonce';};
 f.execution.discardHandoff=()=>{discarded=true;};
 f.account.dispatch=async(_p,_h,on)=>{on();throw Error('unexpected POST');};
 await assert.rejects(executeReferenceReprint(f.execution),/fresh|stale/i);assert.equal(discarded,true);
});
