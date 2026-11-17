import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveCompletedJobReference,revalidateCompletedJobReference} from '../dist/account/reprint.js';
function fixture() {
 const task={id:'12345678901234567890',deviceId:'20PTEST',status:2,isPrintable:true,isDelete:false,mode:'cloud_file',modelId:'model_123',profileId:456,instanceId:789,plateIndex:2,deviceModel:'X2D',bedType:'textured_plate',useAms:true,isPublicProfile:false,amsMapping:[0,1],nozzleMapping:[0,1],amsMapping2:[{amsId:0,slotId:0},{amsId:0,slotId:1}],secret:'must not pass',arbitrary:{bad:true}};
 task.amsDetailMapping=[{ams:0,amsId:0,slotId:0,nozzleId:0,filamentId:'discard'},{ams:1,amsId:0,slotId:1,nozzleId:1}];
 const profile={profileId:456,modelId:'model_123',extention:{modelInfo:{plates:[{index:1,nozzleDiameters:[0.4],filaments:[{id:'1',type:'PETG'}]},{index:2,nozzleDiameters:[0.4,0.4],filaments:[{id:'1',type:'PLA'},{id:'2',type:'PETG'}]}]}}};
 let taskReads=0,profileReads=0;const reads={fetchTask:async id=>{taskReads++;assert.equal(id,'12345678901234567890');return structuredClone(task);},fetchProfile:async (model,id)=>{profileReads++;assert.equal(model,'model_123');assert.equal(id,456);return structuredClone(profile);}};
 return {task,profile,reads,counts:()=>[taskReads,profileReads]};
}
test('completed owned non-cloud-slice job yields bounded reference only, never arbitrary fields',async()=>{
 const f=fixture(),r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);
 assert.equal(r.verification,'provider_completed_job_reference');assert.equal(r.sourceTaskId,f.task.id);assert.equal(r.payload.mode,'auto_repeat');assert.equal(r.payload.plateIndex,2);
 assert.deepEqual(r.declared.materials,[{id:1,type:'PLA',nozzle:0},{id:2,type:'PETG',nozzle:1}]);assert.deepEqual(r.declared.nozzleDiameters,[0.4,0.4]);
 assert.deepEqual(r.declared.physicalNozzleIndices,[0,1]);assert.equal(r.payload.amsDetailMapping[0].filamentId,undefined);
 assert.doesNotMatch(JSON.stringify(r),/must not pass|arbitrary|sliced.*inspected/);assert.deepEqual(f.counts(),[1,1]);
 const again=await revalidateCompletedJobReference(r,f.reads);assert.deepEqual(again,r);assert.deepEqual(f.counts(),[2,2]);
});
for(const [name,change] of [
 ['wrong task',f=>f.task.id='999'],['wrong printer',f=>f.task.deviceId='OTHER'],['not successful',f=>f.task.status=3],['not printable',f=>f.task.isPrintable=false],['cloud slice',f=>f.task.mode='cloud_slice'],['missing instance',f=>delete f.task.instanceId],['missing device model',f=>delete f.task.deviceModel],['missing profile',f=>f.profile.profileId=555],['missing plate',f=>f.profile.extention.modelInfo.plates.pop()],['missing nozzle',f=>delete f.profile.extention.modelInfo.plates[1].nozzleDiameters],['missing material',f=>f.profile.extention.modelInfo.plates[1].filaments=[]],['contradictory nozzle',f=>f.task.nozzleInfos=[{id:0,diameter:0.8},{id:1,diameter:0.4}]],['mismatched structured mapping',f=>f.task.amsMapping2.pop()],['missing mapping',f=>delete f.task.amsMapping],['duplicate material',f=>f.profile.extention.modelInfo.plates[1].filaments[1].id='1'],['unsafe integer',f=>f.task.profileId=Number.MAX_SAFE_INTEGER+1],
]) test(`${name} fails closed`,async()=>{const f=fixture();change(f);await assert.rejects(resolveCompletedJobReference('12345678901234567890','20PTEST',f.reads),/requires_original_file/);});
test('changed profile reference evidence is rejected on revalidation',async()=>{
 const f=fixture(),r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);
 f.profile.extention.modelInfo.plates[1].filaments[0].type='ABS';
 await assert.rejects(revalidateCompletedJobReference(r,f.reads),/requires_original_file/);
});

test('caller modification cannot masquerade as a revalidated reference',async()=>{const f=fixture(),r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);r.payload.bedType='other';await assert.rejects(revalidateCompletedJobReference(r,f.reads),/requires_original_file/);});

test('source mode changes invalidate the revalidated reference',async()=>{const f=fixture(),r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);f.task.mode='lan_file';await assert.rejects(revalidateCompletedJobReference(r,f.reads),/requires_original_file/);});

test('source wire nozzle_diameters and task IDs normalize without changing nozzle identity',async()=>{
 const f=fixture(),plate=f.profile.extention.modelInfo.plates[1];delete plate.nozzleDiameters;plate.nozzle_diameters='0.4 0.4';
 f.task.nozzleInfos=[{id:1,diameter:0.4},{id:0,diameter:0.4}];
 let r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);assert.equal(r.declared.nozzleSource,'task_and_profile');
 delete plate.nozzle_diameters;r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);assert.equal(r.declared.nozzleSource,'task');
});
for (const change of [f=>f.task.nozzleInfos=[{id:1,diameter:0.4},{id:1,diameter:0.4}],f=>f.task.nozzleInfos=[{id:14,diameter:0.4}],f=>f.profile.extention.modelInfo.plates[1].nozzle_diameters='0.8 0.4']) test('ambiguous source nozzle data fails',async()=>{const f=fixture();change(f);await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads),/requires_original_file/);});
for (const change of [f=>f.task.amsDetailMapping.pop(),f=>f.task.amsDetailMapping.push({...f.task.amsDetailMapping[0]}),f=>f.task.amsDetailMapping[0].slotId=1,f=>f.task.amsDetailMapping[0].nozzleId=1,f=>delete f.task.amsDetailMapping[0].slotId]) test('missing, duplicate or conflicting nozzle join refuses',async()=>{const f=fixture();change(f);await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads),/requires_(?:original_file|current_mapping)/);});
test('legacy flat detail mapping joins by exact source slot without structured fields',async()=>{const f=fixture();for(const d of f.task.amsDetailMapping){delete d.amsId;delete d.slotId;}const r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads);assert.deepEqual(r.declared.physicalNozzleIndices,[0,1]);});
test('retained history shaped explicit structured conflict requires current mapping',async()=>{const f=fixture();f.profile.extention.modelInfo.plates[1].filaments=[{id:'2',type:'PETG'},{id:'3',type:'PLA-S'}];f.task.amsMapping=[-1,1,128,-1,-1];f.task.amsMapping2=[{amsId:255,slotId:255},{amsId:0,slotId:1},{amsId:128,slotId:0},{amsId:255,slotId:255},{amsId:255,slotId:255}];f.task.nozzleMapping=null;f.task.amsDetailMapping=[{ams:1,amsId:0,slotId:0,nozzleId:1},{ams:128,amsId:0,slotId:0,nozzleId:0}];await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads),/requires_current_mapping/);});
test('explicit current selection retains original nozzles and rejects altered evidence',async()=>{const f=fixture();f.task.amsDetailMapping[0].slotId=3;const selected=[{filamentId:1,ams:2,amsId:0,slotId:2},{filamentId:2,ams:128,amsId:128,slotId:0}];const r=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads,selected);assert.equal(r.declared.mappingSource,'explicit_current_selection');assert.deepEqual(r.declared.physicalNozzleIndices,[0,1]);assert.deepEqual(r.payload.amsMapping,[2,128]);assert.deepEqual(r.payload.amsDetailMapping.map(d=>d.nozzleId),[0,1]);assert.deepEqual(await revalidateCompletedJobReference(r,f.reads,selected),r);f.task.amsDetailMapping[0].nozzleId=1;await assert.rejects(revalidateCompletedJobReference(r,f.reads,selected),/requires_original_file/);});
for(const selection of [[{filamentId:1,ams:1,amsId:0,slotId:1}],[{filamentId:1,ams:1,amsId:0,slotId:1},{filamentId:1,ams:2,amsId:0,slotId:2}],[{filamentId:1,ams:1,amsId:0,slotId:2},{filamentId:2,ams:128,amsId:128,slotId:0}],[{filamentId:1,ams:1,amsId:0,slotId:1,nozzle:1},{filamentId:2,ams:128,amsId:128,slotId:0}]])test('invalid explicit mapping refuses',async()=>{const f=fixture();await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads,selection),/requires_original_file/);});
test('historical flat and structured conflict needs a current selection even when detail agrees',async()=>{const f=fixture();f.task.amsMapping2[0].slotId=2;f.task.amsDetailMapping[0].slotId=2;await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads),/requires_current_mapping/);const mapping=[{filamentId:1,ams:2,amsId:0,slotId:2},{filamentId:2,ams:128,amsId:128,slotId:0}];const ref=await resolveCompletedJobReference(f.task.id,'20PTEST',f.reads,mapping);assert.deepEqual(ref.declared.physicalNozzleIndices,[0,1]);assert.deepEqual(ref.payload.amsMapping,[2,128]);});
test('historical duplicate used physical target needs a current selection',async()=>{const f=fixture();f.task.amsMapping[1]=0;f.task.amsMapping2[1]={amsId:0,slotId:0};await assert.rejects(resolveCompletedJobReference(f.task.id,'20PTEST',f.reads),/requires_current_mapping/);});
