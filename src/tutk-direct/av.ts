/** Framed AV session, protocol described in open-bamboo-networking 77de55a,
 * research/06.07-tutk.md §§6.7.3–6.7.5. Transport carries only authenticated
 * DTLS application records. One operation, no reconnect or command replay. */
import {randomBytes} from 'node:crypto';
import {FrameReceiver} from './frames.js';
import {ControlReplies,makeControlRequest,type FileOperation} from './ctrl.js';
import {UploadReceipt,deleteRequest,type prepareUpload} from './mutations.js';
/** Encode one bounded IOCtrl; caller supplies the independent AV and request counters. */
export function encodeIoControl(type:number,body:Buffer,packetSequence:number,requestIndex:number):Buffer {
 if(!Number.isInteger(type)||type<0||type>0xffffffff||body.length>1020||!Number.isInteger(packetSequence)||packetSequence<0||packetSequence>65535||!Number.isInteger(requestIndex)||requestIndex<0||requestIndex>65535)throw Error('Invalid control message');
 const p=Buffer.alloc(40+body.length);p[0]=12;p.writeUInt16LE(11,2);p.writeUInt16LE(packetSequence,4);p[17]=0x70;p.writeUInt16LE(requestIndex,18);p.writeUInt32LE(1,20);p.writeUInt32LE(body.length+4,24);p.writeUInt32LE(requestIndex,28);p.writeUInt32LE(type,36);body.copy(p,40);return p;
}
/** Encode one multi-slice IOCtrl. Counters advance independently for each slice. */
export function encodeIoControlSlices(type:number,body:Buffer,packetSequence:number,sliceCounter:number,requestIndex:number):Buffer[] {
 if(!Number.isInteger(type)||type<0||type>0xffffffff||!Buffer.isBuffer(body)||body.length>32768||![packetSequence,sliceCounter,requestIndex].every(n=>Number.isInteger(n)&&n>=0&&n<=65535))throw Error('Invalid control message');
 const content=Buffer.alloc(4+body.length);content.writeUInt32LE(type);body.copy(content,4);const count=Math.ceil(content.length/1024),packets:Buffer[]=[];
 for(let i=0;i<count;i++){const part=content.subarray(i*1024,(i+1)*1024),p=Buffer.alloc(36+part.length);p[0]=12;p.writeUInt16LE(11,2);p.writeUInt16LE((packetSequence+i)&65535,4);p[17]=0x70;p.writeUInt16LE((sliceCounter+i)&65535,18);p.writeUInt16LE(count,20);p.writeUInt16LE(i,22);p.writeUInt32LE(part.length,24);p.writeUInt32LE(requestIndex,28);part.copy(p,36);packets.push(p);}return packets;
}
export function encodeProbeAck(clock:number,received:number):Buffer {
 if(!Number.isInteger(clock)||clock<0||clock>65535||!Number.isInteger(received)||received<0||received>65535)throw Error('Invalid probe');
 const p=Buffer.alloc(20);p[0]=11;p.writeUInt16LE(11,2);p[6]=31;p.writeUInt16LE(clock,8);p.writeUInt16LE(received,10);p.writeUInt16LE(received,12);return p;
}
export function encodeAvLogin(mode:'framed'|'legacy',step:0|32,nonce:number,password:string,uid:string):Buffer {
 if(!Number.isInteger(nonce)||nonce<0||nonce>0xffffffff||!password||Buffer.byteLength(password)>256||(mode==='legacy'&&!/^[A-Za-z0-9]{20}$/.test(uid)))throw Error('Invalid login');
 const p=Buffer.alloc(570);p.writeUInt16LE(11,2);p.writeUInt16LE(546,16);p.writeUInt32LE(nonce,20);
 if(mode==='framed'){p[1]=step;p[18]=step===0?1:0;p.writeUInt32LE(1,538);p.writeUInt32LE(4,542);p.writeUInt32LE(0x001f07fb,546);p.writeUInt32LE(3,560);p.writeUInt32LE(1,566);}
 else{p[0]=step;p.write(uid.toUpperCase(),542,'ascii');p.writeUInt32LE(2,566);}
 p.write('admin',24,'ascii');p.write(password,281,'utf8');return p;
}
export function encodeInitialProbe(sequence:number,clock:number):Buffer {const p=Buffer.alloc(16);p[0]=10;p[1]=8;p.writeUInt16LE(11,2);p.writeUInt16LE(sequence,4);p.writeUInt16LE(clock,8);p.writeUInt16LE(50,10);p.writeUInt32LE(0x30,12);return p;}
export function encodeInitialHeartbeat(sequence:number,clock:number):Buffer {const p=Buffer.alloc(24);p[0]=9;p.writeUInt16LE(11,2);p.writeUInt16LE(sequence,4);p.fill(255,8,14);p.writeUInt16LE(clock,20);return p;}
/** RFC-style 16-bit sequence comparison; exactly half a cycle is not newer.
 * Source wire behavior: TutkSession.cpp 425–428 at pinned revision 77de55a. */
export function isNewerStreamCounter(current:number,previous:number):boolean {
 if(!Number.isInteger(current)||current<0||current>65535||!Number.isInteger(previous)||previous<0||previous>65535)throw Error('Invalid stream counter');
 const delta=(current-previous)&0xffff;return delta>0&&delta<0x8000;
}
export interface AvDatagramChannel {send(data:Buffer):Promise<void>; authorize?():Promise<void>; verify?():void; onData(callback:(data:Buffer)=>void):()=>void;}
export type AvOperation={operation:'camera'}|FileOperation|{operation:'upload';job:ReturnType<typeof prepareUpload>;storage:'emmc'|'udisk'};
export type AvResult={kind:'camera';frames:Buffer[]}|{kind:'files';value:unknown};
export async function runAvSession(channel:AvDatagramChannel,password:string,operation:AvOperation,signal:AbortSignal,onReady?:()=>void,uid?:string,onHandoff?:()=>void,onUploadAck?:()=>void):Promise<AvResult>{
 if(!password||Buffer.byteLength(password)>256||signal.aborted)throw Error('Invalid AV session');
 let sequence=1,ctrlSequence=0,sliceCounter=0,heartbeat=0,received=0,newest=0xffff,hasNewest=false,reported=0xffff,first=true,probeFirst=true;
 let uploadPhase:'init'|'terminal'|'ackwait'|'list'|'download'='init',uploadPath:string|undefined,uploadReader:ControlReplies|undefined,chunkTask:Promise<void>=Promise.resolve(),allChunksDispatched=false;
 const upload=operation.operation==='upload'?new UploadReceipt(operation.job):undefined;
 let deleteStage:'list'|'delete'='list',deleteReader:ControlReplies|undefined;
 if(operation.operation==='delete')deleteReader=new ControlReplies({operation:'list',kind:operation.kind,storage:operation.storage});
 let mode:'framed'|'legacy'='framed',initialPending=true,initialized=false,accepted=false,controlSent=false,settled=false,completing=false,retries=0,nextRetry=0,lastHb=0,lastProbe=0,chain=Promise.resolve();
 const frames:Buffer[]=[];let frameBytes=0,gotKey=false,legacyFrame=-1,legacyCount=0;const legacyPieces=new Map<number,Buffer>();
 const replies=operation.operation==='camera'||operation.operation==='upload'||operation.operation==='delete'?undefined:new ControlReplies(operation);
 let resolveResult!:(v:AvResult)=>void,rejectResult!:(e:Error)=>void;
 const done=new Promise<AvResult>((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
 const reject=(error?:unknown)=>{if(!settled){settled=true;rejectResult(error instanceof Error?error:Error('AV session failed'));}};
 const finish=(v:AvResult)=>{if(!settled&&!completing){completing=true;void chain.then(()=>{if(!settled){settled=true;resolveResult(v);}},reject);}};
 const send=(buf:Buffer,onStart?:()=>void)=>{chain=chain.then(async()=>{if(settled||signal.aborted)return;await channel.authorize?.();if(settled||signal.aborted)return;channel.verify?.();onStart?.();return channel.send(buf);});void chain.catch(reject);};
 const head=(type:number,flag:number,length:number)=>{const p=Buffer.alloc(length);p[0]=type;p[1]=flag;p.writeUInt16LE(11,2);p.writeUInt16LE(sequence++&0xffff,4);return p;};
 const controlPacket=(type:number,body:Buffer)=>{
  if(mode==='framed')return encodeIoControlSlices(type,body,sequence++&0xffff,sliceCounter++&0xffff,ctrlSequence++&0xffff)[0];
  const p=head(0,0x70,32+body.length);p[9]=0x70;p.writeUInt32LE(1,12);p.writeUInt32LE(body.length+4,16);p.writeUInt32LE(type,28);body.copy(p,32);return p;
 };
 const ioctl=(type:number,body:Buffer,onStart?:()=>void)=>send(controlPacket(type,body),onStart);
 const probe=()=>{const p=head(10,8,16);p.writeUInt16LE(Date.now()&0xffff,8);p.writeUInt16LE(50,10);p.writeUInt32LE(probeFirst?0x30:1,12);probeFirst=false;send(p);};
 const ping=()=>{const p=head(9,0,24);if(first){p.fill(255,8,14);first=false;}else{p.writeUInt16LE(reported,8);p.writeUInt16LE(newest,10);p.writeUInt32LE(1,12);reported=newest;}p.writeUInt16LE(heartbeat++&0xffff,18);p.writeUInt16LE(Date.now()&0xffff,20);send(p);};
 const ack=(clock:number)=>{const p=encodeProbeAck(clock,received&0xffff);received=0;send(p);};
 const emit=(data:Buffer,key:boolean)=>{if(!initialized||settled||completing)return;try{
  if(operation.operation==='upload'){
   if(!controlSent)return;
   if(uploadPhase==='init'||uploadPhase==='terminal'){
    const head=data.indexOf('\n\n');const value=JSON.parse((head<0?data:data.subarray(0,head)).toString('utf8'));
    if(value.cmdtype===0xffffffff||value.cmdtype===0x100||value.cmdtype===0x101)return;
    if(uploadPhase==='init'){const chunks=upload!.initialized(value);uploadPhase='terminal';chunkTask=sendChunks(chunks);void chunkTask.catch(reject);return;}
    if(!allChunksDispatched)throw Error('Premature upload completion');uploadPhase='ackwait';void chunkTask.then(()=>{if(settled||signal.aborted)return;try{upload!.completed(value);onUploadAck?.();uploadPhase='list';uploadReader=new ControlReplies({operation:'list',kind:'model',storage:operation.storage},2);const request=JSON.parse(makeControlRequest({operation:'list',kind:'model',storage:operation.storage}).toString());request.sequence=2;ioctl(0x3001,Buffer.from(JSON.stringify(request)));}catch(error){reject(error);}},reject);return;
   }
   if(uploadPhase==='ackwait')return;
   const value=uploadReader!.consume(data) as any;if(!value)return;
   if(uploadPhase==='list'){const matches=(value.replies as any[]).flatMap(x=>x.file_lists).filter((x:any)=>typeof x.path==='string'&&x.path.split('/').at(-1)===operation.job.remoteName);
    if(matches.length!==1){finish({kind:'files',value:{uploadReceipt:upload!.unreadable(),path:null,name:operation.job.remoteName}});return;}
    uploadPath=matches[0].path;uploadPhase='download';uploadReader=new ControlReplies({operation:'download',path:uploadPath!},3);const request=JSON.parse(makeControlRequest({operation:'download',path:uploadPath!}).toString());request.sequence=3;ioctl(0x3001,Buffer.from(JSON.stringify(request)));return;
   }
   const receipt=upload!.verified(value.bytes);finish({kind:'files',value:{uploadReceipt:receipt,path:uploadPath,name:operation.job.remoteName}});return;
  }
  if(operation.operation==='delete'){if(!controlSent)return;const value=deleteReader!.consume(data) as any;if(!value)return;if(deleteStage==='list'){const matches=(value.replies as any[]).flatMap(x=>x.file_lists).filter((x:any)=>x&&x.path===operation.path);if(matches.length!==1||(operation.expectedSize!==undefined&&matches[0].size!==operation.expectedSize))throw Error('File precheck failed');deleteStage='delete';deleteReader=new ControlReplies(operation,2);ioctl(0x3001,deleteRequest(operation.path,true,2),onHandoff);return;}finish({kind:'files',value});return;}
  if(replies){if(!controlSent)return;const value=replies.consume(data);if(value)finish({kind:'files',value});return;}
  if(!gotKey&&!key)return;gotKey=true;frames.push(Buffer.from(data));frameBytes+=data.length;if(frameBytes>16*1024*1024)throw Error('Frame limit');
  finish({kind:'camera',frames});
 }catch(error){reject(error);}};
 const receiver=new FrameReceiver(emit,operation.operation!=='camera');
 const start=()=>{if(operation.operation==='camera'){ioctl(0x1ff,Buffer.alloc(8));if(mode==='legacy'){const body=Buffer.alloc(8);body.writeUInt32LE(1);ioctl(0x1ff,body);}}};
 const sendChunks=async(chunks:Buffer[])=>{for(let i=0;i<chunks.length;i++){if(settled||signal.aborted)return;const packets=encodeIoControlSlices(0x3001,chunks[i],sequence,sliceCounter,ctrlSequence++&65535);sequence=(sequence+packets.length)&65535;sliceCounter=(sliceCounter+packets.length)&65535;for(let j=0;j<packets.length;j++)send(packets[j],i===chunks.length-1&&j===packets.length-1?()=>{allChunksDispatched=true}:undefined);await chain;if(i<chunks.length-1)await new Promise<void>(r=>setTimeout(r,50));}};
 const issueControl=()=>{if((replies||upload||deleteReader)&&accepted&&!controlSent){const request=operation.operation==='upload'?operation.job.init:makeControlRequest(operation as FileOperation);controlSent=true;ioctl(0x3001,request,operation.operation==='upload'?onHandoff:undefined);}};
 const nonce=randomBytes(4).readUInt32LE();
 const login=()=>{for(const step of [0,32] as const){const value=mode==='framed'?((nonce+(step?1:0))>>>0):(sequence++>>>0);send(encodeAvLogin(mode,step,value,password,uid??''));}};
 const initialize=()=>{if(initialized)return;initialized=true;onReady?.();if(mode==='framed')probe();start();if(mode==='framed')ping();const now=Date.now();lastHb=lastProbe=now;nextRetry=now+1500;issueControl();};
 const legacy=(p:Buffer)=>{
  const kind=p[0]===1?p[1]:p[0],extra=(p[1]&8)?8:0,offset=8+extra;
  if(p[0]!==1&&(p[0]<3||p[0]>8)||kind===4||p.length<offset+20)return;
  if(p[1]&8){const a=head(11,0,20);a.writeUInt16LE(p.readUInt16LE(4),8);a.writeUInt16LE(1,10);a.writeUInt16LE(heartbeat++&0xffff,12);send(a);}
  const i=p.readUInt16LE(offset+2),count=p.readUInt16LE(offset+4),size=p.readUInt16LE(offset+8),id=p.readUInt32LE(offset+12);
  if(!count||count>4096||i>=count||!size||size>1024||offset+20+size>p.length)return;
  if(id!==legacyFrame){legacyFrame=id;legacyCount=count;legacyPieces.clear();}
  if(legacyCount!==count||legacyPieces.has(i))return;legacyPieces.set(i,Buffer.from(p.subarray(offset+20,offset+20+size)));
  if(legacyPieces.size!==count)return;const pieces:Buffer[]=[];let total=0;for(let j=0;j<count;j++){const x=legacyPieces.get(j);if(!x)return;total+=x.length;if(total>4*1024*1024){legacyPieces.clear();return;}pieces.push(x);}legacyPieces.clear();
  let data=Buffer.concat(pieces),key=data[0]===255&&data[1]===216;
  const starts=(b:Buffer)=>b.length>=4&&b[0]===0&&b[1]===0&&(b[2]===1||(b[2]===0&&b[3]===1));
  if(!key&&data.length>16&&(starts(data.subarray(16))||data[16]===255&&data[17]===216)){key=data[2]===1;data=data.subarray(16);}
  if(!key&&starts(data)){const n=data[2]===1?3:4;key=(data[n]&31)===5||(data[n]&31)===7;}emit(data,key);
 };
 const unsubscribe=channel.onData(p=>{if(settled||completing)return;try{
  if(initialPending){
   initialPending=false;
   if(p.length>=40&&p[0]===0&&p[1]===0x21){
    const capability=p.readUInt32LE(36);
    if(capability===0){if(replies||upload||deleteReader)throw Error('Legacy file control unsupported');mode='legacy';accepted=true;login();}
    else accepted=true;
   }
   initialize();return;
  }
  if(p.length<8||p.readUInt16LE(2)!==11)return;
  received++;
  if(p[0]===0&&p[1]===0x21){if(mode==='legacy'){start();}else if((replies||upload||deleteReader)&&!accepted){accepted=true;issueControl();}}
  else if(mode==='legacy'&&p[0]===0){
   if((p[1]===0x10||p[1]===0x70)&&p.length>=24){const answer=Buffer.from(p.subarray(0,24));answer[1]=p[1]===0x10?0x11:0x71;if(p[1]===0x10)answer[9]=0x11;answer[16]=answer[17]=0;send(answer);}
   else if(p[1]===0x12&&p.length>=24){const answer=Buffer.alloc(44);p.copy(answer,0,0,24);answer[1]=0x13;answer[16]=20;if(p.length>=44)p.copy(answer,24,24,44);send(answer);}
  } else if(mode==='legacy')legacy(p);
  else if(p[0]===12){const offset=(p[1]&8)?16:8;if(p.length>=offset+8){const k=p[offset+3],m=p.readUInt32LE(offset+4),idx=p[offset+2];if(k>0&&k<=32&&m<=32&&idx<k+m){const current=p.readUInt16LE(4);if(!hasNewest||isNewerStreamCounter(current,newest))newest=current;hasNewest=true;}}const clock=receiver.accept(p);if(clock!==undefined)ack(clock);}
  else if(p[0]===10&&p.length>=16)ack(p.readUInt16LE(8));
 }catch{reject();}});
 const isLegacy=()=>mode==='legacy';
 const timer=setTimeout(reject,operation.operation==='upload'?55000:30000),initial=setTimeout(()=>{try{if(initialPending){initialPending=false;initialize();}}catch{reject();}},800);
 const tick=setInterval(()=>{if(!initialized||settled||completing)return;try{const now=Date.now();if(mode==='framed'&&now-lastHb>=100){lastHb=now;ping();}if(mode==='framed'&&now-lastProbe>=200){lastProbe=now;probe();}
  if(now>=nextRetry&&((replies||upload||deleteReader)?!accepted:frames.length===0)){if(++retries>5)throw Error('AV login timed out');nextRetry=now+1500;login();start();}
 }catch{reject();}},50);
 signal.addEventListener('abort',reject,{once:true});
 try{
  login();const result=await done;await chain;
  if(operation.operation==='camera'&&!signal.aborted){await channel.send(controlPacket(0x2ff,Buffer.alloc(8)));if(isLegacy()&&!signal.aborted){const body=Buffer.alloc(8);body.writeUInt32LE(1);await channel.send(controlPacket(0x2ff,body));}}
  return result;
 }finally{clearTimeout(timer);clearTimeout(initial);clearInterval(tick);signal.removeEventListener('abort',reject);unsubscribe();await chunkTask.catch(()=>{});}
}
