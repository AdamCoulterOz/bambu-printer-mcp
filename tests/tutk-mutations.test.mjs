import test from 'node:test';import assert from 'node:assert/strict';
import {deleteRequest,correlatedMutationReply,prepareUpload} from '../dist/tutk-direct/mutations.js';
test('delete is explicit exact path and reply must correlate',()=>{
 assert.deepEqual(JSON.parse(deleteRequest('/userdata/model/a.3mf',true)).req.paths,['/userdata/model/a.3mf']);
 for(const p of ['/userdata/*','/x/../y','/x/'])assert.throws(()=>deleteRequest(p,true));assert.throws(()=>deleteRequest('/x',false));
 assert.equal(correlatedMutationReply({cmdtype:3,sequence:1,result:0},3,1),0);assert.throws(()=>correlatedMutationReply({cmdtype:3,sequence:2,result:0},3,1));
});
test('upload binds immutable bytes, rotation consent and final-only digest',()=>{
 const input=Buffer.alloc(40000,7);assert.throws(()=>prepareUpload(input,'part.3mf','emmc',false));assert.throws(()=>prepareUpload(input,'part.3mf','udisk',false));const job=prepareUpload(input,'part.3mf','emmc',true);input.fill(0);
 const chunks=job.chunks(31,0);assert.equal(chunks.length,2);let decoded=chunks.map(x=>{const i=x.indexOf('\n\n');return [JSON.parse(x.subarray(0,i)),x.subarray(i+2)]});
 assert.equal(decoded[0][0].req.file_md5,undefined);assert.equal(decoded[1][0].req.file_md5,job.md5);assert.equal(decoded[0][1][0],7);assert.throws(()=>job.chunks(32,0));assert.throws(()=>job.chunks(31,1));
});
test('multi-slice IOCtrl carries ordered bounded payload with independent counters',async()=>{
 const {encodeIoControlSlices,encodeIoControl}=await import('../dist/tutk-direct/av.js');
 const body=Buffer.alloc(2500,7),slices=encodeIoControlSlices(0x3001,body,65535,65535,8);
 assert.equal(slices.length,3);assert.equal(slices[0].readUInt16LE(4),65535);assert.equal(slices[1].readUInt16LE(4),0);assert.equal(slices[1].readUInt16LE(18),0);
 assert.deepEqual(Buffer.concat(slices.map(x=>x.subarray(36))),Buffer.concat([Buffer.from([1,48,0,0]),body]));
 assert.deepEqual(encodeIoControlSlices(0x3001,Buffer.from('abc'),1,2,2)[0],encodeIoControl(0x3001,Buffer.from('abc'),1,2));
});
test('upload receipt refuses existing destination and requires final ack plus matching readback',async()=>{
 const {UploadReceipt}=await import('../dist/tutk-direct/mutations.js');const job=prepareUpload(Buffer.from('hello'),'x.3mf','emmc',true);
 assert.throws(()=>new UploadReceipt(job).initialized({cmdtype:5,sequence:1,result:19}));
 const receipt=new UploadReceipt(job);assert.equal(receipt.initialized({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}).length,1);
 assert.throws(()=>receipt.verified(Buffer.from('hello')));receipt.completed({cmdtype:5,sequence:1,result:0});assert.throws(()=>receipt.verified(Buffer.from('bad')));assert.equal(receipt.verified(Buffer.from('hello')).status,'verified');
 const other=new UploadReceipt(job);other.initialized({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}});other.completed({cmdtype:5,sequence:1,result:0});assert.equal(other.unreadable().status,'uploaded_unverified');
});
test('mutation handoff classifies pre-send and possible delivery without retry',async()=>{
 const {MutationHandoff}=await import('../dist/tutk-direct/mutations.js');const m=new MutationHandoff('upload','unique.3mf',{sha256:'a',md5:'b',size:1,historyRotationAllowed:true});
 assert.equal(m.failure().receipt.status,'not_sent');m.beforeSend();const receipt=m.failure().receipt;assert.equal(receipt.status,'unknown');assert.equal(receipt.retryable,false);assert.equal(receipt.historyEffectsUncertain,true);assert.throws(()=>m.beforeSend());
});
test('delete rejects escaped and UTF-8 paths whose wire JSON exceeds one IOCtrl',()=>{
 assert.throws(()=>deleteRequest('/'+ '"'.repeat(600),true));assert.throws(()=>deleteRequest('/'+'é'.repeat(495),true));
});
