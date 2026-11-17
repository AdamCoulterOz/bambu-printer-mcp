/** IOTC UDP transport and LAN discovery. Wire facts: open-bamboo-networking
 * 77de55a, research/06.07-tutk.md and IotcClient.cpp:385–445,2100–2230.
 * All datagrams are bounded and checked against the selected peer and token. */
import dgram from 'node:dgram';
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {networkInterfaces} from 'node:os';
import {transcode,decodeDatagram} from './transcode.js';
export type Peer={address:string;port:number};
type Item={data:Buffer;peer:Peer};
export interface IotcTransport {send(data:Buffer,epoch:number,sequence:number,signal?:AbortSignal):Promise<void>;receive(deadline:number,signal?:AbortSignal):Promise<Buffer|undefined>;close(graceful?:boolean):Promise<void>;}
export function lanTargets():string[]{
 const targets=new Set<string>(['255.255.255.255']);
 for(const entries of Object.values(networkInterfaces()))for(const entry of entries??[]){
  if(entry.family!=='IPv4'||entry.internal)continue;const ip=entry.address.split('.').map(Number),mask=entry.netmask.split('.').map(Number);
  if(ip.length===4&&mask.length===4)targets.add(ip.map((v,i)=>(v|(~mask[i]&255))).join('.'));
 }return [...targets];
}
export function discoveryPacket(uid:string,authkey:string,token:Buffer):Buffer{
 if(!/^[A-Z0-9]{20}$/.test(uid)||!/^[\x21-\x7e]{1,256}$/.test(authkey)||token.length!==8)throw Error('Invalid discovery');
 const p=Buffer.alloc(88);p.set([4,2,28,2]);p.writeUInt32LE(72,4);p.set([1,6,33],8);p.write(uid,16,'ascii');p.set([4,3,3,4],52);token.copy(p,56);p[64]=1;p.write(authkey.slice(0,8),74,'ascii');return transcode(p,'encode');
}
export function encodeData(record:Buffer,token:Buffer,epoch:number,sequence:number):Buffer{
 if(token.length!==8||!Number.isInteger(epoch)||epoch<0||epoch>65535||!Number.isInteger(sequence)||sequence<0||sequence>65535||record.length>16384)throw Error('Invalid data');
 const p=Buffer.alloc(28+record.length);p.set([4,2,28,11]);p.writeUInt16LE(12+record.length,4);p.writeUInt16LE(sequence,6);p.set([7,4,33,0,token[0],token[1],0,1],8);p[16]=12;p.writeUInt16BE(epoch,17);token.copy(p,20);record.copy(p,28);return Buffer.concat([transcode(p.subarray(0,Math.min(p.length,64)),'encode'),p.subarray(64)]);
}
export class SocketQueue {
 private q:Item[]=[];private wake?:()=>void;private dead=false;
 constructor(readonly socket:dgram.Socket){socket.on('message',(data,info)=>{if(this.q.length<256&&data.length<=65535){this.q.push({data,peer:{address:info.address,port:info.port}});this.wake?.();}});socket.on('error',()=>{this.dead=true;this.wake?.();});}
 async next(deadline:number,signal?:AbortSignal):Promise<Item|undefined>{
  while(!this.q.length&&!this.dead){signal?.throwIfAborted();const remaining=deadline-performance.now();if(remaining<=0)return;
   await new Promise<void>(resolve=>{const timer=setTimeout(done,remaining);const abort=()=>done();function done(){clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();}this.wake=()=>{this.wake=undefined;done();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)done();});
  }
  signal?.throwIfAborted();if(this.dead)throw Error('UDP unavailable');return this.q.shift();
 }
}
export async function sendDatagram(socket:dgram.Socket,p:Buffer,peer:Peer):Promise<void>{await new Promise<void>((resolve,reject)=>socket.send(p,peer.port,peer.address,e=>e?reject(e):resolve()));}
/** Internal test seam accepts a fixed target; production uses interface broadcasts. */
export async function openLanIotc(uid:string,authkey:string,signal:AbortSignal,targets:Peer[]=lanTargets().map(address=>({address,port:32761})),timeout=1600):Promise<IotcTransport>{
 const token=randomBytes(8),probe=discoveryPacket(uid.toUpperCase(),authkey,token),socket=dgram.createSocket('udp4'),queue=new SocketQueue(socket);
 let keep=false;
 try{
  await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(0,()=>{socket.removeListener('error',reject);resolve();});});socket.setBroadcast(true);
  const deadline=performance.now()+timeout;let next=0,peer:Peer|undefined;
  while(performance.now()<deadline&&!peer){signal.throwIfAborted();if(performance.now()>=next){await Promise.all(targets.map(t=>sendDatagram(socket,probe,t).catch(()=>{})));next=performance.now()+250;}
   const item=await queue.next(Math.min(next,deadline),signal);if(!item||item.data.length<200)continue;
   let data:Buffer;try{data=transcode(item.data,'decode');}catch{continue;}
   if(data[0]!==4||data[1]!==2||data[8]!==2||data[9]!==6||data[10]!==18||data.subarray(16,36).toString('ascii')!==uid.toUpperCase()||!data.subarray(188,196).equals(token))continue;
   peer=item.peer;
  }
  if(!peer)throw Error('LAN discovery failed');await sendDatagram(socket,probe,peer);
  keep=true;return makeIotcTransport(socket,queue,peer,token,undefined);

 }finally{if(!keep)await closeSocket(socket);}
}

export async function closeSocket(socket:dgram.Socket):Promise<void>{await new Promise<void>(resolve=>{try{socket.close(()=>resolve());}catch{resolve();}});}
export function makeIotcTransport(socket:dgram.Socket,queue:SocketQueue,destination:Peer,token:Buffer,relayTag:number|undefined):IotcTransport {
 let closed=false; const relay=relayTag!==undefined;
 const control=(type:number)=>{const p=Buffer.alloc(24);p.set([4,2,28,10,8,0,0,0,type,relay?5:4,relay?36:33]);if(relay)p.writeUInt32LE(relayTag!,12);token.copy(p,16);return transcode(p,'encode');};
 const alive=relay?undefined:setInterval(()=>{void sendDatagram(socket,control(0x27),destination).catch(()=>{});},2000);alive?.unref();
 return {
  async send(record,epoch,sequence,signal){signal?.throwIfAborted();let wire=encodeData(record,token,epoch,sequence);
   if(relay){const n=Math.min(wire.length,64);const p=Buffer.concat([transcode(wire.subarray(0,n),'decode'),wire.subarray(n)]);p.set([4,5,36,0],8);p[12]=relayTag!&255;p[13]=(relayTag!>>>8)&255;p[14]=(relayTag!>>>16)&255;p[15]=1;p[17]=p[18]=0;wire=Buffer.concat([transcode(p.subarray(0,n),'encode'),p.subarray(n)]);}
   await sendDatagram(socket,wire,destination);signal?.throwIfAborted();},
  async receive(until,signal){while(performance.now()<until){const item=await queue.next(until,signal);if(!item)return;if(item.peer.address!==destination.address||item.peer.port!==destination.port||item.data.length<24)continue;
    let p:Buffer;try{p=decodeDatagram(item.data);}catch{continue;}if(p[0]!==4||p[1]!==2)continue;
    if(relay&&p.length===24&&p[8]===0x23&&p[9]===5&&p[10]===0x42){p.set([0x24,5,0x24],8);void sendDatagram(socket,transcode(p,'encode'),destination).catch(()=>{});continue;}
    const validRoute=relay ? p[8]===3&&p[9]===5&&p[10]===0x42 : p[9]===4&&((p[8]===8&&p[10]===0x12)||(p[8]===7&&p[10]===0x21));
    if(!validRoute||p.length<29||p[3]!==11||p.readUInt16LE(4)!==p.length-16||!p.subarray(20,28).equals(token)||![20,21,22,23].includes(p[28]))continue;return p.subarray(28);
  }},
  async close(graceful=true){if(closed)return;closed=true;if(alive)clearInterval(alive);if(graceful)await sendDatagram(socket,control(relay?0x14:0x17),destination).catch(()=>{});await closeSocket(socket);}
 };
}
