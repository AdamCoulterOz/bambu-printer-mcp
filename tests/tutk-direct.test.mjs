import test from 'node:test';import assert from 'node:assert/strict';
import {recoverDataShards} from '../dist/tutk-direct/fec.js';
import {FrameReceiver} from '../dist/tutk-direct/frames.js';
import {makeControlRequest,ControlReplies} from '../dist/tutk-direct/ctrl.js';
test('Reed–Solomon recovers a missing shard using published k=20 parity coefficient',()=>{
 const rows=new Map();for(let i=1;i<20;i++)rows.set(i,Buffer.from([0]));rows.set(20,Buffer.from([0x8f]));
 assert.equal(recoverDataShards(20,rows,1)[0][0],1);
 assert.throws(()=>recoverDataShards(33,rows,1));assert.throws(()=>recoverDataShards(20,new Map([[1,Buffer.alloc(1)]]),1));
});
function packet({id=1,group=1,index=0,count=1,last=true,content=Buffer.from('abc'),info=0}){
 const p=Buffer.alloc(16+20+content.length);p[0]=12;p.writeUInt16LE(11,2);p.writeUInt16LE(group,8);p[11]=1;
 const s=16;p[s]=5;p[s+1]=Number(last);p.writeUInt16LE(count,s+4);p.writeUInt16LE(last?info:index,s+6);p.writeUInt16LE(content.length,s+8);p.writeUInt32LE(id,s+12);content.copy(p,s+20);return p;
}
test('framed receiver reassembles bounded out-of-order slices and ignores repeats',()=>{
 const emitted=[];const r=new FrameReceiver((f,key)=>emitted.push([f.toString(),key]));
 r.accept(packet({group:1,index:1,count:2,last:true,content:Buffer.from('b')}));
 r.accept(packet({group:2,index:0,count:2,last:false,content:Buffer.from('a')}));
 r.accept(packet({group:3,index:0,count:2,last:false,content:Buffer.from('a')}));
 assert.deepEqual(emitted,[['ab',true]]);r.accept(Buffer.alloc(12));assert.equal(emitted.length,1);
});
test('file CTRL accepts correlated completed listings and checksum-verified fragments only',()=>{
 const req=JSON.parse(makeControlRequest({operation:'list',kind:'model',storage:'emmc'}));assert.deepEqual(req,{cmdtype:1,sequence:1,req:{type:'model',api_version:2,notify:'DETAIL',storage:'emmc'}});
 const listing=new ControlReplies({operation:'list',kind:'model',storage:'emmc'});
 assert.deepEqual(listing.consume(Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[]}}))),{replies:[{file_lists:[]}]});
 const read=new ControlReplies({operation:'download',path:'/userdata/a'});
 const raw=Buffer.from(JSON.stringify({cmdtype:4,sequence:1,result:0,reply:{offset:0,size:3,total:3,file_md5:'900150983cd24fb0d6963f7d28e17f72'}})+'\n\nabc');
 assert.deepEqual(read.consume(raw),{bytes:Buffer.from('abc'),size:3,md5:'900150983cd24fb0d6963f7d28e17f72'});
 const bad=new ControlReplies({operation:'download',path:'/userdata/a'});assert.throws(()=>bad.consume(Buffer.from(raw.toString().replace('"offset":0','"offset":1'))));
 assert.throws(()=>makeControlRequest({operation:'download',path:'/a/../b'}));
});

test('transcode reverses every block and special tail length',async()=>{
 const {transcode,decodeDatagram}=await import('../dist/tutk-direct/transcode.js');
 // Witness generated from pinned upstream protocol test harness, synthetic bytes only.
 const witness=Buffer.from(Array.from({length:88},(_,i)=>(i*37+19)&255));
 assert.equal(transcode(witness,'encode').toString('hex'),'2d265b38eb4fb32afe5ce9893066a51326239628ba45b82d354cee863737af16232cfd380b49bd20505ce3833ac6a31d2c293828da4fb22b9f4ce8883197a51029229738ab43b72e3a5ced853426a917865b608ca0e435e0');
 for(let n=16;n<100;n++){
  const plain=Buffer.from(Array.from({length:n},(_,i)=>(i*37+n)&255));
  assert.deepEqual(transcode(transcode(plain,'encode'),'decode'),plain);
 }
 const d=Buffer.alloc(96);d[0]=4;d[1]=2;d[2]=28;d[3]=11;const encoded=Buffer.concat([transcode(d.subarray(0,64),'encode'),d.subarray(64)]);assert.deepEqual(decodeDatagram(encoded),d);
});

test('AV transport logs in and sends only the read-only file command',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const sent=[];let receive;
 const channel={onData(cb){receive=cb;return()=>{receive=null}},async send(p){sent.push(Buffer.from(p));if(sent.length===2)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=0x21;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack);});
 if(p.length>40 && p.readUInt32LE(36)===0x3001)queueMicrotask(()=>{const body=Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[]}}));const frame=packet({content:body});receive(frame);});}};
 const result=await runAvSession(channel,'pw',{operation:'list',kind:'model',storage:''},new AbortController().signal);
 assert.deepEqual(result,{kind:'files',value:{replies:[{file_lists:[]}]}});
 const controls=sent.filter(p=>p.length>=40&&p[0]===12).map(p=>p.readUInt32LE(36));assert.deepEqual(controls,[0x3001]);assert.equal(receive,null);
});

test('UDP discovery binds a token to selected peer and rejects other senders',async()=>{
 const {createSocket}=await import('node:dgram');const {transcode,decodeDatagram}=await import('../dist/tutk-direct/transcode.js');const {openLanIotc,encodeData}=await import('../dist/tutk-direct/iotc.js');const {performance}=await import('node:perf_hooks');
 const server=createSocket('udp4');await new Promise(r=>server.bind(0,'127.0.0.1',r));let received=0;
 server.on('message',(raw,source)=>{const decoded=decodeDatagram(raw);if(decoded[8]===1&&decoded[9]===6&&decoded[10]===33){
  const reply=Buffer.alloc(200);reply.set([4,2,28,2]);reply.set([2,6,18],8);decoded.copy(reply,16,16,36);decoded.copy(reply,188,56,64);server.send(transcode(reply,'encode'),source.port,source.address);
 }else if(decoded[3]===11){received++;const response=encodeData(Buffer.from([22,1,2]),decoded.subarray(20,28),0,10);server.send(response,source.port,source.address);}});
 const c=await openLanIotc('ABCDEFGHIJKLMNOPQRST','authkey1',new AbortController().signal,[{address:'127.0.0.1',port:server.address().port}],1000);
 await c.send(Buffer.from([22,9]),0,3);assert.deepEqual(await c.receive(performance.now()+1000),Buffer.from([22,1,2]));assert.equal(received,1);await c.close();server.close();
});

test('off-LAN rendezvous accepts relay only from a master-advertised server',async()=>{
 const {createSocket}=await import('node:dgram');const {transcode}=await import('../dist/tutk-direct/transcode.js');const {openRelayIotc}=await import('../dist/tutk-direct/relay.js');
 const master=createSocket('udp4'),relay=createSocket('udp4');
 await new Promise((resolve,reject)=>{master.once('error',reject);master.bind(10240,'127.0.0.1',resolve)});
 await new Promise((resolve,reject)=>{relay.once('error',reject);relay.bind(3478,'127.0.0.1',resolve)});
 master.on('message',(_raw,src)=>{const msg=Buffer.alloc(24);msg.set([4,2,28,2]);msg.set([8,16,131],8);msg.set([2,0,13,150,127,0,0,1],16);master.send(transcode(msg,'encode'),src.port,src.address)});
 relay.on('message',(raw,src)=>{const input=transcode(raw,'decode');if(input[8]===20){const answer=Buffer.alloc(44);answer.set([4,2,28,2]);answer.set([3,3,67],8);answer.writeUInt32LE(123,36);relay.send(transcode(answer,'encode'),src.port,src.address)}});
 try{const result=await openRelayIotc({uid:'ABCDEFGHIJKLMNOPQRST',authkey:'authkey1',region:'us'},new AbortController().signal,async()=>['127.0.0.1']);assert.ok(result.transport);await result.transport.close();}
 finally{master.close();relay.close();}
});

test('direct operation cancellation settles discovery, handshake, and transfer resources',async()=>{
 const {runDirectTutkForTest}=await import('../dist/tutk-direct/index.js');
 const request={session:{uid:'ABCDEFGHIJKLMNOPQRST',authkey:'authkey1',passwd:'pw',region:'us',device:'SERIAL'},operation:'camera'};
 for(const stopAt of ['discovery','handshake','transfer']){
  let released;const entered=new Promise(r=>released=r);let transportClosed=false,closeGraceful,dtlsClosed=false,pendingReceive;
  const transport={send:async()=>{},receive:async()=>undefined,close:async graceful=>{transportClosed=true;closeGraceful=graceful}};
  const waitAbort=signal=>new Promise((_,reject)=>{released();if(signal.aborted)reject(Error('aborted'));else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})});
  const deps={openLan:async(_u,_k,signal)=>stopAt==='discovery'?waitAbort(signal):transport,openRelay:async()=>{throw Error('unexpected retry')},connect:async(_t,_p,options)=>stopAt==='handshake'?waitAbort(options.signal):({send:async()=>{},receive:()=>new Promise(r=>pendingReceive=r),close:()=>{dtlsClosed=true;pendingReceive?.(undefined)}}),
   av:async(_channel,_password,_op,signal,onReady)=>{onReady();return waitAbort(signal)},decode:async()=>Buffer.alloc(0)};
  const abort=new AbortController();const run=runDirectTutkForTest(request,abort.signal,deps);await entered;abort.abort();
  await assert.rejects(run,e=>e.code==='DIRECT_TUTK_CANCEL');
  if(stopAt!=='discovery'){assert.equal(transportClosed,true);assert.equal(closeGraceful,false);}if(stopAt==='transfer')assert.equal(dtlsClosed,true);
 }
});

test('direct list traverses local UDP, a synthetic DTLS seam, AV framing and CTRL projection',async()=>{
 const {createSocket}=await import('node:dgram');const {transcode,decodeDatagram}=await import('../dist/tutk-direct/transcode.js');
 const {openLanIotc,encodeData}=await import('../dist/tutk-direct/iotc.js');const {runDirectTutkForTest}=await import('../dist/tutk-direct/index.js');const {runAvSession}=await import('../dist/tutk-direct/av.js');
 const server=createSocket('udp4');await new Promise(r=>server.bind(0,'127.0.0.1',r));let token,seq=0;
 server.on('message',(wire,src)=>{const p=decodeDatagram(wire);if(p[8]===1&&p[9]===6&&p[10]===33){const d=Buffer.alloc(200);d.set([4,2,28,2]);d.set([2,6,18],8);p.copy(d,16,16,36);p.copy(d,188,56,64);server.send(transcode(d,'encode'),src.port,src.address);return;}
  if(p[3]!==11)return;token=p.subarray(20,28);const body=p.subarray(29);let reply;
  if(body.length===570&&body[1]===0x20){reply=Buffer.alloc(40);reply[1]=0x21;reply.writeUInt16LE(11,2);reply.writeUInt32LE(4,36);}
  else if(body.length>40&&body[0]===12&&body.readUInt32LE(36)===0x3001)reply=packet({content:Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[{name:'sample.3mf',path:'/userdata/sample.3mf',hidden:'x'}]}}))});
  if(reply)server.send(encodeData(Buffer.concat([Buffer.from([23]),reply]),token,0,++seq),src.port,src.address);
 });
 const request={session:{uid:'ABCDEFGHIJKLMNOPQRST',authkey:'authkey1',passwd:'pw',region:'us',device:'SERIAL'},operation:'list',kind:'model',storage:'internal'};
 let next=0;const deps={openLan:(u,k,s)=>openLanIotc(u,k,s,[{address:'127.0.0.1',port:server.address().port}],1000),openRelay:async()=>{throw Error('unexpected relay')},connect:async(t)=>({send:b=>t.send(Buffer.concat([Buffer.from([23]),b]),0,++next),receive:async d=>(await t.receive(d))?.subarray(1),close:()=>{}}),av:runAvSession,decode:async()=>{throw Error('unexpected decoder')}};
 try{assert.deepEqual(await runDirectTutkForTest(request,undefined,deps),{kind:'list',files:[{type:'model',name:'sample.3mf',path:'/userdata/sample.3mf'}]});}finally{server.close();}
});

test('independent shared TUTK vectors match encoder, slices, FEC, checksum and probe ack',async()=>{
 const {readFile}=await import('node:fs/promises');const {encodeIoControl,encodeProbeAck}=await import('../dist/tutk-direct/av.js');
 const file=JSON.parse(await readFile(new URL('./fixtures/tutk-wire/vectors.json',import.meta.url),'utf8'));const v=Object.fromEntries(file.vectors.map(x=>[x.name,x]));
 for(const name of ['framed_camera_start_channel_0','framed_camera_stop_channel_0','framed_list_model_internal','framed_file_download']){
  const item=v[name],i=item.input,data=Buffer.from(i.data_hex??Buffer.from(i.json_utf8).toString('hex'),'hex');assert.equal(encodeIoControl(i.io_type,data,i.packet_sequence,i.request_index).toString('hex'),item.packet_hex);
 }
 const got=[];const rx=new FrameReceiver(b=>got.push(b.toString()));for(const hex of v.framed_ctrl_reply_two_slices.packet_hex)rx.accept(Buffer.from(hex,'hex'));assert.deepEqual(got,[v.framed_ctrl_reply_two_slices.input.expected_utf8]);
 const shard=new Map([[1,Buffer.from(v.fec_k2_parity_row2.data_hex[1],'hex')],[2,Buffer.from(v.fec_k2_parity_row2.parity_hex,'hex')]]);assert.equal(recoverDataShards(2,shard,4)[0].toString('hex'),v.fec_k2_parity_row2.data_hex[0]);
 const term=v.download_terminal_with_binary;const reader=new ControlReplies({operation:'download',path:'/synthetic/sample.3mf'},term.sequence);const value=reader.consume(Buffer.from(term.frame_hex,'hex'));assert.equal(value.bytes.toString('hex'),term.binary_hex);assert.equal(value.md5,term.md5);
 assert.equal(encodeProbeAck(v.probe_ack.echo_ms16,v.probe_ack.received_since_ack).toString('hex'),v.probe_ack.packet_hex);
 const invalid=new FrameReceiver(()=>assert.fail('invalid slice emitted'));for(const name of ['invalid_slice_zero_count','invalid_slice_truncated']){const b=Buffer.from(v[name].slice_hex,'hex'),p=Buffer.alloc(16+b.length);p[0]=12;p.writeUInt16LE(11,2);p[11]=1;b.copy(p,16);invalid.accept(p);}
});

test('independent AV login and initial timing packet vectors match',async()=>{
 const {readFile}=await import('node:fs/promises');const {encodeAvLogin,encodeInitialProbe,encodeInitialHeartbeat}=await import('../dist/tutk-direct/av.js');
 const v=JSON.parse(await readFile(new URL('./fixtures/tutk-wire/av-login.json',import.meta.url),'utf8'));const by=Object.fromEntries(v.requests.map(x=>[x.name,x.hex]));
 assert.equal(encodeAvLogin('framed',0,v.inputs.framed_nonce,'dummy',v.inputs.synthetic_uid_ascii).toString('hex'),by.framed_step_00);
 assert.equal(encodeAvLogin('framed',32,v.inputs.framed_nonce+1,'dummy',v.inputs.synthetic_uid_ascii).toString('hex'),by.framed_step_20);
 assert.equal(encodeAvLogin('legacy',0,1,'dummy',v.inputs.synthetic_uid_ascii).toString('hex'),by.legacy_step_00);
 assert.equal(encodeAvLogin('legacy',32,2,'dummy',v.inputs.synthetic_uid_ascii).toString('hex'),by.legacy_step_20);
 assert.equal(encodeInitialProbe(1,0x1234).toString('hex'),v.synthetic_initial_packets[0].hex);
 assert.equal(encodeInitialHeartbeat(2,0x1234).toString('hex'),v.synthetic_initial_packets[1].hex);
});

test('legacy zero-capability camera falls back and yields a real legacy JPEG frame',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const sent=[];let receive;
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));
  if(sent.length===2)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=33;ack.writeUInt16LE(11,2);receive(ack)});
  if(p[0]===0&&p[1]===0x70&&p.length>=32&&p.readUInt32LE(28)===0x1ff&&sent.filter(x=>x[0]===0&&x[1]===0x70&&x.length>=32&&x.readUInt32LE(28)===0x1ff).length===2){const data=Buffer.from([255,216,255,217]);const frame=Buffer.alloc(28+data.length);frame[0]=1;frame[1]=5;frame.writeUInt16LE(11,2);frame.writeUInt16LE(1,12);frame.writeUInt16LE(data.length,16);frame.writeUInt32LE(1,20);data.copy(frame,28);queueMicrotask(()=>receive(frame));}
 }};
 const result=await runAvSession(channel,'dummy',{operation:'camera'},new AbortController().signal,undefined,'0123456789ABCDEFGHIJ');
 assert.equal(result.kind,'camera');assert.deepEqual(result.frames[0],Buffer.from([255,216,255,217]));
 assert.equal(sent[2][0],0);assert.equal(sent[3][0],32);assert.equal(sent[2].readUInt32LE(20),1);assert.equal(sent[3].readUInt32LE(20),2);
 assert.equal(sent.filter(p=>p[0]===0&&p[1]===0x70&&p.length>=32&&p.readUInt32LE(28)===0x1ff).length,2);
});

test('lost first CTRL login retries identical pair and duplicate late ACK sends one file request',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive;const sent=[];let replies=0;
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));
  if(p.length===570&&sent.filter(x=>x.length===570).length===4){const ack=Buffer.from('00210b0000000000','hex');queueMicrotask(()=>{receive(ack);receive(ack)});}
  if(p[0]===12&&p.length>40&&p.readUInt32LE(36)===0x3001){replies++;const frame=packet({content:Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[]}}))});queueMicrotask(()=>receive(frame));}
 }};
 const result=await runAvSession(channel,'dummy',{operation:'list',kind:'model',storage:''},new AbortController().signal);
 assert.equal(result.kind,'files');const logins=sent.filter(x=>x.length===570);assert.equal(logins.length,4);assert.deepEqual(logins[0],logins[2]);assert.deepEqual(logins[1],logins[3]);assert.equal(replies,1);
 const probe=sent.find(x=>x[0]===10);const heartbeat=sent.find(x=>x[0]===9);assert.equal(probe.readUInt16LE(4),1);assert.equal(heartbeat.readUInt16LE(4),2);
});

test('camera starts after the first 800 ms without a login reply and requires actual frame',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const sent=[];let receive;
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));if(p.length>=40&&p[0]===12&&p.readUInt32LE(36)===0x1ff){const frame=packet({content:Buffer.from([255,216,255,217])});queueMicrotask(()=>receive(frame));}}};
 const result=await runAvSession(channel,'dummy',{operation:'camera'},new AbortController().signal,undefined,'0123456789ABCDEFGHIJ');assert.deepEqual(result.frames[0],Buffer.from([255,216,255,217]));
 const probe=sent.find(x=>x[0]===10),start=sent.find(x=>x[0]===12&&x.length>=40&&x.readUInt32LE(36)===0x1ff),hb=sent.find(x=>x[0]===9);
 assert.equal(probe.readUInt16LE(4),1);assert.equal(start.readUInt16LE(4),2);assert.equal(hb.readUInt16LE(4),3);
});

test('heartbeat newest ignores control packets and cancellation sends no stop',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const sent=[];let receive;const abort=new AbortController();
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));if(sent.length===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=33;a.writeUInt16LE(11,2);a.writeUInt32LE(2,36);receive(a);const control=Buffer.alloc(16);control[0]=12;control.writeUInt16LE(11,2);control.writeUInt16LE(55,4);receive(control)});}};
 const work=runAvSession(channel,'dummy',{operation:'camera'},abort.signal,undefined,'0123456789ABCDEFGHIJ');
 await new Promise(r=>setTimeout(r,140));const noData=sent.filter(x=>x[0]===9).at(-1);assert.equal(noData.readUInt16LE(10),0xffff);
 const slice=packet({id:5,group:1,count:2,index:0,last:false,content:Buffer.from('x')});slice.writeUInt16LE(7,4);receive(slice);
 await new Promise(r=>setTimeout(r,130));const withData=sent.filter(x=>x[0]===9).at(-1);assert.equal(withData.readUInt16LE(10),7);
 abort.abort();await assert.rejects(work);const count=sent.length;await new Promise(r=>setTimeout(r,150));assert.equal(sent.length,count);assert.equal(sent.some(p=>p[0]===12&&p.length>=40&&p.readUInt32LE(36)===0x2ff),false);
});

test('legacy capability rejects file CTRL before sending a file request',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive;const sent=[];
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));if(sent.length===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=33;a.writeUInt16LE(11,2);receive(a)});}};
 await assert.rejects(runAvSession(channel,'dummy',{operation:'list',kind:'model',storage:''},new AbortController().signal,undefined,'0123456789ABCDEFGHIJ'));
 assert.equal(sent.some(p=>p[0]===12&&p.length>=40&&p.readUInt32LE(36)===0x3001),false);
});

test('a single actual H.264 keyframe is decoded without waiting for thirty frames',async()=>{
 const {spawnSync}=await import('node:child_process');const {runAvSession}=await import('../dist/tutk-direct/av.js');const {decodeCameraFrames}=await import('../dist/tutk-direct/index.js');
 const encoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:s=64x64:r=1','-frames:v','1','-c:v','libx264','-f','h264','pipe:1'],{maxBuffer:1024*1024});
 assert.equal(encoded.status,0);const raw=encoded.stdout;assert.ok(raw.length>0);let receive;const sent=[];
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));if(sent.length===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=33;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});
  if(p[0]===12&&p.length>=40&&p.readUInt32LE(36)===0x1ff)queueMicrotask(()=>{const n=Math.ceil(raw.length/1024);for(let i=0;i<n;i++){const frame=packet({id:1,group:i+1,index:i,count:n,last:i===n-1,content:raw.subarray(i*1024,Math.min(raw.length,(i+1)*1024))});receive(frame)}});
 }};
 const began=Date.now();const result=await runAvSession(channel,'dummy',{operation:'camera'},new AbortController().signal,undefined,'0123456789ABCDEFGHIJ');
 assert.equal(result.frames.length,1);assert.ok(Date.now()-began<500);const image=await decodeCameraFrames(result.frames,new AbortController().signal);assert.equal(image.subarray(0,2).toString('hex'),'ffd8');assert.equal(image.subarray(-2).toString('hex'),'ffd9');
});

test('invalid and truncated camera elementary streams are rejected',async()=>{
 const {decodeCameraFrames}=await import('../dist/tutk-direct/index.js');
 for(const frame of [Buffer.from('not-a-codec'),Buffer.from([0,0,0,1,0x67]),Buffer.from([255,216,0,0])])
  await assert.rejects(decodeCameraFrames([frame],new AbortController().signal));
});

test('stream progress counters advance with 16-bit wrap and never regress',async()=>{
 const {isNewerStreamCounter}=await import('../dist/tutk-direct/av.js');
 for(const [current,previous,expected] of [[2,1,true],[1,2,false],[1,1,false],[0,65535,true],[65535,0,false],[65535,65534,true],[65534,65535,false],[32768,0,false],[0,32768,false]])assert.equal(isNewerStreamCounter(current,previous),expected,`${previous} -> ${current}`);
 assert.throws(()=>isNewerStreamCounter(-1,0));assert.throws(()=>isNewerStreamCounter(0,65536));
});

test('multi-frame download advances only as heartbeat acknowledges stream progress',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {createHash}=await import('node:crypto');
 let receive,next=0;const seen=[],data=Buffer.from('abcdefghijkl'),md5=createHash('md5').update(data).digest('hex');
 const sendFragment=()=>{const i=next++,part=data.subarray(i*4,i*4+4),reply={cmdtype:4,sequence:1,result:i===2?0:1,reply:{offset:i*4,size:4,total:12,...(i===2?{file_md5:md5}:{})}};
  const frame=packet({id:i+1,group:i+1,content:Buffer.concat([Buffer.from(JSON.stringify(reply)+'\n\n'),part])});frame.writeUInt16LE(100+i,4);queueMicrotask(()=>receive(frame));};
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){
  if(p.length===570&&p[1]===32)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=33;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack)});
  if(p[0]===12&&p.length>=40&&p.readUInt32LE(36)===0x3001)sendFragment();
  if(p[0]===9&&!p.subarray(8,14).equals(Buffer.alloc(6,255))){const newest=p.readUInt16LE(10);seen.push(newest);if(next<3&&newest===99+next)sendFragment();}
 }};
 const result=await runAvSession(channel,'dummy',{operation:'download',path:'/userdata/sample'},AbortSignal.timeout(2000));
 assert.deepEqual(result,{kind:'files',value:{bytes:data,size:12,md5}});assert.deepEqual(seen.slice(0,2),[100,101]);
});

test('heartbeat distinguishes a real 65535 stream counter from uninitialized state',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive;const sent=[];const abort=new AbortController();
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){sent.push(Buffer.from(p));if(sent.length===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=33;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});}};
 const run=runAvSession(channel,'dummy',{operation:'camera'},abort.signal,undefined,'0123456789ABCDEFGHIJ');
 await new Promise(r=>setTimeout(r,20));
 for(const [seq,id] of [[65535,1],[65534,2]]){const x=packet({id,group:id,count:2,last:false,content:Buffer.from('x')});x.writeUInt16LE(seq,4);receive(x);}
 await new Promise(r=>setTimeout(r,130));assert.equal(sent.filter(p=>p[0]===9).at(-1).readUInt16LE(10),65535);
 const wrap=packet({id:3,group:3,count:2,last:false,content:Buffer.from('x')});wrap.writeUInt16LE(0,4);receive(wrap);
 await new Promise(r=>setTimeout(r,130));assert.equal(sent.filter(p=>p[0]===9).at(-1).readUInt16LE(10),0);
 abort.abort();await assert.rejects(run);
});

test('ordered CTRL frames emit observed 0,1,2,3,6,4,5 arrival in sequence; camera stays immediate',()=>{
 const ordered=[],camera=[];const a=new FrameReceiver(b=>ordered.push(b.toString()),true),b=new FrameReceiver(x=>camera.push(x.toString()));
 for(const id of [0,1,2,3,6,4,5]){const p=packet({id,group:id+1,content:Buffer.from(String(id))});a.accept(p);b.accept(p);}
 assert.deepEqual(ordered,['0','1','2','3','4','5','6']);assert.deepEqual(camera,['0','1','2','3','6','4','5']);
});

test('ordered replies survive completed-frame reordering with contiguous bytes and final MD5',async()=>{
 const {createHash}=await import('node:crypto');const data=Buffer.from('abcdefghijklmnopqrstuvwxyzaa'),md5=createHash('md5').update(data).digest('hex');
 const replies=new ControlReplies({operation:'download',path:'/userdata/example'});let outcome;
 const frames=new FrameReceiver(bytes=>{outcome=replies.consume(bytes)??outcome},true);
 for(const id of [0,1,2,3,6,4,5]){const part=data.subarray(id*4,id*4+4),reply={cmdtype:4,sequence:1,result:id===6?0:1,reply:{offset:id*4,size:part.length,total:data.length,...(id===6?{file_md5:md5}:{})}};
  const content=Buffer.concat([Buffer.from(JSON.stringify(reply)+'\n\n'),part]);frames.accept(packet({id,group:id+1,content}));}
 assert.deepEqual(outcome,{bytes:data,size:data.length,md5});
});

test('ordered frame IDs handle wrap, old duplicates, ambiguous half-range and skipped audio',()=>{
 const result=[];const rx=new FrameReceiver(bytes=>result.push(bytes.toString()),true);
 for(const [id,text] of [[0xfffffffe,'a'],[0,'c'],[0xffffffff,'b'],[0xffffffff,'duplicate'],[0x80000001,'ambiguous'],[1,'d']])rx.accept(packet({id,group:((id&65535)+1)&65535,content:Buffer.from(text)}));
 assert.deepEqual(result,['a','b','c','d']);
 const next=[];const audio=new FrameReceiver(b=>next.push(b.toString()),true);const silent=packet({id:10,group:1,content:Buffer.from('audio')});silent[16]=4;audio.accept(silent);audio.accept(packet({id:11,group:2,content:Buffer.from('after')}));assert.deepEqual(next,['after']);
});

test('ordered receiver fails instead of evicting a missing head or exceeding aggregate byte limit',()=>{
 const rx=new FrameReceiver(()=>{},true);for(let id=0;id<16;id++)rx.accept(packet({id,group:id+1,count:2,index:0,last:false,content:Buffer.from('x')}));
 assert.throws(()=>rx.accept(packet({id:16,group:17,count:2,index:0,last:false,content:Buffer.from('x')})),/backlog exceeded/);
 const large=new FrameReceiver(()=>{},true),slice=Buffer.alloc(1044);slice[0]=5;slice.writeUInt16LE(4096,4);slice.writeUInt16LE(1024,8);
 for(let id=0;id<4;id++){slice.writeUInt32LE(id,12);for(let i=0;i<4095;i++){slice.writeUInt16LE(i,6);large.slice(slice);}}
 slice.writeUInt32LE(4,12);for(let i=0;i<4;i++){slice.writeUInt16LE(i,6);large.slice(slice);}slice.writeUInt16LE(4,6);assert.throws(()=>large.slice(slice),/byte limit exceeded/);
});

test('CTRL permanent gap stays pending until cancellation and never replays file request',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive,requests=0;const controller=new AbortController();
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p.length===570&&p[1]===32)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=33;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack)});
  if(p[0]===12&&p.length>=40&&p.readUInt32LE(36)===0x3001){requests++;const frame=(id,offset)=>packet({id,group:id+1,content:Buffer.from(JSON.stringify({cmdtype:4,sequence:1,result:1,reply:{offset,size:0,total:1}}))});queueMicrotask(()=>{receive(frame(0,0));receive(frame(2,0));});}}
 };
 const work=runAvSession(channel,'dummy',{operation:'download',path:'/userdata/a'},controller.signal);await new Promise(r=>setTimeout(r,150));controller.abort();await assert.rejects(work);assert.equal(requests,1);
});

test('ordered receiver holds a later frame until FEC recovers the missing head slice',()=>{
 const received=[];const rx=new FrameReceiver(bytes=>received.push(bytes.toString()),true);
 rx.accept(packet({id:10,group:1,count:2,index:0,last:false,content:Buffer.from('a')}));
 rx.accept(packet({id:11,group:2,content:Buffer.from('next')}));assert.deepEqual(received,[]);
 const missing=packet({id:10,group:3,count:2,index:1,last:true,content:Buffer.from('b')}).subarray(16);
 const parity=Buffer.alloc(16+20+missing.length);parity[0]=12;parity.writeUInt16LE(11,2);parity.writeUInt16LE(3,8);parity[10]=1;parity[11]=1;parity.writeUInt32LE(1,12);parity.writeUInt16LE(missing.length,24);missing.copy(parity,36);
 rx.accept(parity);assert.deepEqual(received,['ab','next']);
});
test('delete checks exact unique listing before correlated terminal response',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive,marked=0,sends=0,requests=[];const target='/userdata/model/a.3mf';
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(++sends===2)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=0x21;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack)});if(p.length>40&&p.readUInt32LE(36)===0x3001){const v=JSON.parse(p.subarray(40));requests.push(v);if(v.cmdtype===1){assert.equal(marked,0);queueMicrotask(()=>receive(packet({id:1,content:Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[{path:target,size:3}]}}))})));}else{assert.equal(marked,1);queueMicrotask(()=>receive(packet({id:2,group:2,content:Buffer.from(JSON.stringify({cmdtype:3,sequence:2,result:0}))})));}}}};
 const out=await runAvSession(channel,'pw',{operation:'delete',path:target,confirm:true,kind:'model',storage:'emmc',expectedSize:3},new AbortController().signal,undefined,undefined,()=>marked++);
 assert.equal(marked,1);assert.deepEqual(requests.map(x=>x.cmdtype),[1,3]);assert.deepEqual(out,{kind:'files',value:{deleteResult:0}});
});
test('upload AV sends init and chunks once then lists and verifies readback',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload}=await import('../dist/tutk-direct/mutations.js');let receive,marked=0,acknowledged=0,login=0,frameId=1,requests=[];
 const job=prepareUpload(Buffer.from('abc'),'fixture.3mf','emmc',true),path='/userdata/model/history/'+job.remoteName;
 const sendFrame=payload=>queueMicrotask(()=>receive(packet({id:frameId++,group:frameId,content:Buffer.from(payload)})));
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p.length<=40||p[0]!==12||p.readUInt32LE(36)!==0x3001)return;
  const payload=p.subarray(40),split=payload.indexOf('\n\n');const v=JSON.parse((split<0?payload:payload.subarray(0,split)).toString());requests.push(v);
  if(v.cmdtype===5&&v.req.total){assert.equal(marked,1);sendFrame(JSON.stringify({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}));}
  else if(v.cmdtype===5)sendFrame(JSON.stringify({cmdtype:5,sequence:1,result:0}));
  else if(v.cmdtype===1)sendFrame(JSON.stringify({cmdtype:1,sequence:2,result:0,reply:{file_lists:[{path}]}}));
  else if(v.cmdtype===4)sendFrame(JSON.stringify({cmdtype:4,sequence:3,result:0,reply:{offset:0,size:3,total:3,file_md5:job.md5}})+'\n\nabc');
 }};
 const out=await runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},new AbortController().signal,undefined,undefined,()=>marked++,()=>acknowledged++);
 assert.equal(marked,1);assert.equal(acknowledged,1);assert.equal(out.value.uploadReceipt.status,'verified');assert.equal(out.value.path,path);assert.deepEqual(requests.map(x=>x.cmdtype),[5,5,1,4]);
});
test('upload refuses FILE_EXIST without chunks',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload,UploadRejected}=await import('../dist/tutk-direct/mutations.js');let receive,login=0,controls=0;
 const job=prepareUpload(Buffer.from('abc'),'fixture.3mf','emmc',true);
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p.length>40&&p[0]===12&&p.readUInt32LE(36)===0x3001){controls++;queueMicrotask(()=>receive(packet({content:Buffer.from(JSON.stringify({cmdtype:5,sequence:1,result:19}))})));}}};
 await assert.rejects(runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},new AbortController().signal,undefined,undefined,()=>{}),UploadRejected);assert.equal(controls,1);
});
test('upload multi-slice frames reconstruct chunks and advance independent control indexes',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload}=await import('../dist/tutk-direct/mutations.js');const source=Buffer.alloc(40000,0x41),job=prepareUpload(source,'fixture.3mf','emmc',true);let receive,login=0,frameId=0;const parts=new Map(),requests=[],indexes=[];
 const respond=data=>queueMicrotask(()=>receive(packet({id:frameId++,group:frameId,content:Buffer.from(data)})));
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p[0]!==12||p.length<36||p[17]!==0x70)return;
  const count=p.readUInt16LE(20),part=p.readUInt16LE(22),index=p.readUInt32LE(28);let item=parts.get(index);if(!item){item=[];parts.set(index,item)}item[part]=p.subarray(36);if(item.filter(Boolean).length!==count)return;
  indexes.push(index);const full=Buffer.concat(item);assert.equal(full.readUInt32LE(0),0x3001);const payload=full.subarray(4),i=payload.indexOf('\n\n'),v=JSON.parse((i<0?payload:payload.subarray(0,i)).toString());requests.push([v,i<0?Buffer.alloc(0):payload.subarray(i+2)]);
  if(v.cmdtype===5&&v.req.total)respond(JSON.stringify({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}));
  else if(v.cmdtype===5&&v.req.file_md5)respond(JSON.stringify({cmdtype:5,sequence:1,result:0}));
  else if(v.cmdtype===1)respond(JSON.stringify({cmdtype:1,sequence:2,result:0,reply:{file_lists:[]}}));
 }};
 const out=await runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},new AbortController().signal,undefined,undefined,()=>{});
 assert.equal(out.value.uploadReceipt.status,'uploaded_unverified');assert.deepEqual(indexes,[0,1,2,3]);assert.deepEqual(Buffer.concat(requests.filter(([v])=>v.cmdtype===5&&!v.req.total).map(([,b])=>b)),source);
});
test('upload cancellation after first chunk settles without sending later chunks',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload}=await import('../dist/tutk-direct/mutations.js');const job=prepareUpload(Buffer.alloc(40000,1),'fixture.3mf','emmc',true);const abort=new AbortController();let receive,login=0,controls=0,marked=0;
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p.length>40&&p[0]===12&&p.readUInt32LE(36)===0x3001){controls++;if(controls===1)queueMicrotask(()=>receive(packet({content:Buffer.from(JSON.stringify({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}))})));else abort.abort();}}};
 await assert.rejects(runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},abort.signal,undefined,undefined,()=>marked++));const atClose=controls;await new Promise(r=>setTimeout(r,100));assert.equal(marked,1);assert.equal(controls,atClose);assert.equal(controls,2);
});
test('upload rejects a premature terminal ACK before chunks are sent',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload}=await import('../dist/tutk-direct/mutations.js');const job=prepareUpload(Buffer.alloc(40000),'fixture.3mf','emmc',true);let receive,login=0;
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p.length>40&&p[0]===12&&p.readUInt32LE(36)===0x3001){const v=JSON.parse(p.subarray(40).toString());if(v.req.total)queueMicrotask(()=>{receive(packet({id:1,content:Buffer.from(JSON.stringify({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}))}));receive(packet({id:2,group:2,content:Buffer.from(JSON.stringify({cmdtype:5,sequence:1,result:0}))}));});}}};
 await assert.rejects(runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},new AbortController().signal,undefined,undefined,()=>{}));
});
test('duplicate listed paths never send delete or mark handoff',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive,sends=0,marked=0,controls=0;const path='/userdata/model/a.3mf';
 const channel={onData(cb){receive=cb;return()=>{}},async send(p){if(++sends===2)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=0x21;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack)});if(p.length>40&&p.readUInt32LE(36)===0x3001){controls++;queueMicrotask(()=>receive(packet({content:Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[{path,size:3},{path,size:4}]}}))})));}}};
 await assert.rejects(runAvSession(channel,'pw',{operation:'delete',path,confirm:true,kind:'model',storage:'emmc',expectedSize:3},new AbortController().signal,undefined,undefined,()=>marked++));assert.equal(marked,0);assert.equal(controls,1);
});
test('paused pre-delete authority guard prevents actual delete send after revocation',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');let receive,sends=0,marked=0,enter,release,pause=false;const ready=new Promise(r=>enter=r),commands=[];const path='/userdata/model/a.3mf';let valid=true;
 const channel={onData(cb){receive=cb;return()=>{}},async authorize(){if(pause){pause=false;enter();await new Promise(r=>release=r);if(!valid)throw Error('revoked')}},async send(p){if(++sends===2)queueMicrotask(()=>{const ack=Buffer.alloc(40);ack[1]=0x21;ack.writeUInt16LE(11,2);ack.writeUInt32LE(4,36);receive(ack)});if(p.length>40&&p.readUInt32LE(36)===0x3001){const v=JSON.parse(p.subarray(40));commands.push(v.cmdtype);if(v.cmdtype===1)queueMicrotask(()=>{pause=true;receive(packet({content:Buffer.from(JSON.stringify({cmdtype:1,sequence:1,result:0,reply:{file_lists:[{path}]}}))}));});}}};
 const operation=runAvSession(channel,'pw',{operation:'delete',path,confirm:true,kind:'model',storage:'emmc'},new AbortController().signal,undefined,undefined,()=>marked++);
 const failure=assert.rejects(operation);await ready;valid=false;release();await failure;assert.deepEqual(commands,[1]);assert.equal(marked,0);
});
test('serialized upload authorization stops remaining packets after revocation',async()=>{
 const {runAvSession}=await import('../dist/tutk-direct/av.js');const {prepareUpload}=await import('../dist/tutk-direct/mutations.js');const job=prepareUpload(Buffer.alloc(40000,1),'fixture.3mf','emmc',true);let receive,login=0,controls=0,marked=0,valid=true;
 const channel={onData(cb){receive=cb;return()=>{}},async authorize(){if(!valid)throw Error('revoked')},verify(){if(!valid)throw Error('revoked')},async send(p){if(p[0]===0&&++login===2)queueMicrotask(()=>{const a=Buffer.alloc(40);a[1]=0x21;a.writeUInt16LE(11,2);a.writeUInt32LE(4,36);receive(a)});if(p.length>40&&p[0]===12&&p.readUInt32LE(36)===0x3001){controls++;if(controls===1)queueMicrotask(()=>receive(packet({content:Buffer.from(JSON.stringify({cmdtype:5,sequence:1,result:1,reply:{chunk_size:31,offset:0}}))})));else valid=false;}}};
 await assert.rejects(runAvSession(channel,'pw',{operation:'upload',job,storage:'emmc'},new AbortController().signal,undefined,undefined,()=>marked++));const stopped=controls;await new Promise(r=>setTimeout(r,100));assert.equal(marked,1);assert.equal(stopped,2);assert.equal(controls,stopped);
});
