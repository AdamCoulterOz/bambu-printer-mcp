/** Off-LAN IOTC rendezvous. Packet fields documented in open-bamboo-networking
 * 77de55a src/camera/tutk/IotcClient.cpp:1305–1905 and research/06.07-tutk.md.
 * Addresses returned by the fixed regional masters are transient UDP candidates;
 * endpoint selection never replaces PSK authentication in the DTLS layer. */
import dgram from 'node:dgram';import {Resolver,resolve4} from 'node:dns/promises';import {randomBytes} from 'node:crypto';import {performance} from 'node:perf_hooks';
import {transcode} from './transcode.js';import {SocketQueue,sendDatagram,makeIotcTransport,closeSocket,type Peer,type IotcTransport} from './iotc.js';
type Credentials={uid:string;authkey:string;region:string};
function header(size:number,type:number[]):Buffer{const p=Buffer.alloc(size);p.set([4,2,28,2]);p.writeUInt32LE(size-16,4);p.set(type,8);return p;}
const encoded=(p:Buffer)=>transcode(p,'encode');
function endpoint(buf:Buffer,i:number):Peer|undefined {if(i+8>buf.length||buf[i+1]!==0||![0,2].includes(buf[i]))return;const port=buf.readUInt16BE(i+2),address=[...buf.subarray(i+4,i+8)].join('.');if(!port||address==='0.0.0.0')return;return {address,port};}
function addressAt(p:Buffer,i:number,peer:Peer,family:number){p[i]=family;p.writeUInt16BE(peer.port,i+2);peer.address.split('.').forEach((v,n)=>p[i+4+n]=Number(v));}
function uidAt(p:Buffer,uid:string){p.write(uid,16,'ascii');}
function packetJoin(uid:string):Buffer{const p=header(54,[7,16,24]);uidAt(p,uid);p.write(uid.slice(0,16),36,'ascii');p[52]=6;return encoded(p);}
function keyPacket(uid:string,key:string):Buffer{const p=header(48,[20,2,36]);uidAt(p,uid);p.write(key,40,'ascii');return encoded(p);}
function tokenPacket(uid:string,key:string,token:Buffer):Buffer{const p=header(64,[10,2,36]);uidAt(p,uid);token.copy(p,36);p[44]=60;p.write(key,56,'ascii');return encoded(p);}
function punch(uid:string,token:Buffer,local:Peer,reflexive:Peer):Buffer{const p=header(544,[4,8,36]);uidAt(p,uid);p.set([0,2,255,4,166,255,255,255,0,0,0,0,4,3,3,4],52);token.copy(p,68);addressAt(p,76,local,0);addressAt(p,140,reflexive,2);p.set([66,2,0,0],540);return encoded(p);}
function announce(uid:string,key:string,token:Buffer,local:Peer):Buffer{const p=header(288,[3,2,52]);uidAt(p,uid);addressAt(p,36,local,0);token.copy(p,100);p[108]=2;p.write(key,272,'ascii');return encoded(p);}
function punchRequest(uid:string,token:Buffer):Buffer{const p=header(60,[9,2,36]);uidAt(p,uid);token.copy(p,36);p[44]=1;p.set([4,3,3,4,28,0,0,0,2,0,0,0],48);return encoded(p);}
function candidateProbe(uid:string,token:Buffer,step:number):Buffer{const p=header(52,[step,4,51]);uidAt(p,uid);token.copy(p,36);if(step===1)randomBytes(4).copy(p,48);return encoded(p);}
function directedKnock(uid:string,token:Buffer):Buffer{const p=header(88,[1,6,33]);uidAt(p,uid);p.set([4,3,3,4],52);token.copy(p,56);p.set([2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,99,4,19,19,4,12,12,99],64);return encoded(p);}
function relayAck(uid:string,token:Buffer,tag:number):Buffer{const p=header(44,[12,3,36]);p.writeUInt32LE(tag,12);uidAt(p,uid);token.copy(p,36);return encoded(p);}
function stun(token:Buffer):Buffer{const p=header(24,[3,128,63]);token.copy(p,16);return encoded(p);}
async function routeAddress(peer:Peer,signal:AbortSignal):Promise<string> {
 const probe=dgram.createSocket('udp4');
 try {
  return await new Promise<string>((resolve,reject)=>{let done=false;const timer=setTimeout(()=>finish(),1000);const abort=()=>finish();
   function finish(value?:string){if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(value)resolve(value);else reject(Error('No UDP route'));}
   probe.once('error',()=>finish());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return finish();
   probe.connect(peer.port,peer.address,()=>{const a=probe.address();finish(typeof a==='string'?undefined:a.address);});
  });
 } finally {await closeSocket(probe);}
}
export async function openRelayIotc(credentials:Credentials,signal:AbortSignal, dns?:typeof resolve4):Promise<{transport:IotcTransport;sendProbe?:()=>Promise<void>}>{
 const uid=credentials.uid.toUpperCase(),key=credentials.authkey.slice(0,8),region=credentials.region.toLowerCase();
 if(!/^[A-Z0-9]{20}$/.test(uid)||!/^[\x21-\x7e]{1,256}$/.test(credentials.authkey)||!['us','eu','cn'].includes(region))throw Error('Invalid relay session');
 const token=randomBytes(8),socket=dgram.createSocket('udp4'),queue=new SocketQueue(socket);let keep=false;
 try{
  await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(0,()=>{socket.removeListener('error',reject);resolve();});});
  const names=[`${region}-m1.iotcplatform.com`,`${region}-m2.iotcplatform.com`,'m1.iotcplatform.com','m2.iotcplatform.com','m3.iotcplatform.com'];
  const resolver=dns?undefined:new Resolver();const lookup=dns??resolver!.resolve4.bind(resolver!);
  const resolved=await new Promise<string[][]>((resolve,reject)=>{
   let done=false;const timer=setTimeout(()=>finish(),4000);const abort=()=>finish();
   function finish(value?:string[][]){if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);resolver?.cancel();if(value)resolve(value);else reject(Error('DNS lookup failed'));}
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return finish();
   void Promise.all(names.map(n=>lookup(n).catch(()=>[]))).then(v=>finish(v),()=>finish());
  });signal.throwIfAborted();
  const masters=[...new Set(resolved.flat())].slice(0,4).map(address=>({address,port:10240}));if(!masters.length)throw Error('Relay unavailable');
  await Promise.all(masters.map(peer=>sendDatagram(socket,packetJoin(uid),peer).catch(()=>{})));
  const joinDeadline=performance.now()+9000;let masterReply:Buffer|undefined;
  while(performance.now()<joinDeadline){const item=await queue.next(joinDeadline,signal);if(!item)break;let p:Buffer;try{p=transcode(item.data,'decode')}catch{continue;}
   if(p.length>=16&&p[0]===4&&p[1]===2&&p[8]===8&&p[9]===16&&p[10]===131&&masters.some(m=>m.address===item.peer.address&&m.port===item.peer.port)){masterReply=p;break;}
  }
  if(!masterReply)throw Error('Master unavailable');
  const servers:Peer[]=[];let reflexive:Peer|undefined;
  for(let i=16;i+8<=masterReply.length;i++){const a=endpoint(masterReply,i);if(!a||masterReply[i]!==2)continue;if(a.port===3478){if(!servers.some(x=>x.address===a.address))servers.push(a);}else if(!reflexive)reflexive=a;}
  servers.splice(4);if(!servers.length)throw Error('No rendezvous servers');
  const local={address:await routeAddress(servers[0],signal),port:(socket.address() as {port:number}).port},transaction=randomBytes(8);let observed=reflexive??servers[0];
  const sendAll=async(p:Buffer)=>{await Promise.all(servers.map(a=>sendDatagram(socket,p,a).catch(()=>{})));};
  await sendAll(stun(transaction));await sendAll(keyPacket(uid,key));
  let candidates:Peer[]=[],last=0;const deadline=performance.now()+15000;
  while(performance.now()<deadline){signal.throwIfAborted();if(performance.now()-last>=500){last=performance.now();await sendAll(keyPacket(uid,key));for(const a of candidates)await sendDatagram(socket,candidateProbe(uid,token,1),a).catch(()=>{});if(candidates.length)await sendAll(punchRequest(uid,token));}
   const item=await queue.next(Math.min(deadline,performance.now()+250),signal);if(!item)continue;let p:Buffer;try{p=transcode(item.data,'decode')}catch{continue;}if(p.length<16||p[0]!==4||p[1]!==2)continue;
   const fromServer=servers.some(a=>a.address===item.peer.address&&a.port===item.peer.port);
   if(p.length>=192&&p[8]===2&&p[9]===6&&p[10]===18&&p.subarray(16,36).toString('ascii')===uid&&p.subarray(188,192).equals(token.subarray(0,4))){await sendDatagram(socket,directedKnock(uid,token),item.peer);keep=true;return {transport:makeIotcTransport(socket,queue,item.peer,token,undefined)};}
   if(fromServer&&p[8]===4&&p[9]===128){observed=endpoint(p,16)??observed;continue;}
   if(fromServer&&p[8]===39&&p[9]===2&&p[10]===66){await sendAll(punch(uid,token,local,observed));await sendAll(stun(transaction));continue;}
   if(fromServer&&p[8]===21&&p[9]===2&&p[10]===66){await sendAll(announce(uid,key,token,local));await sendAll(tokenPacket(uid,key,token));continue;}
   if(fromServer&&p[8]===1&&p[9]===3&&p[10]===67){candidates=[];for(let i=36;i+8<=p.length&&candidates.length<4;i+=16){const a=endpoint(p,i);if(a)candidates.push(a);}await sendAll(punchRequest(uid,token));continue;}
   if(p.length>=44&&p[9]===4&&p[10]===51&&p.subarray(16,36).toString('ascii')===uid&&p.subarray(36,44).equals(token)&&candidates.some(a=>a.address===item.peer.address&&a.port===item.peer.port)){
    if(p[8]===1){await sendDatagram(socket,candidateProbe(uid,token,2),item.peer);continue;}
    if(p[8]===2||p[8]===4){if(p[8]===2)await sendDatagram(socket,candidateProbe(uid,token,4),item.peer);const peer=item.peer;keep=true;return {transport:makeIotcTransport(socket,queue,peer,token,undefined),sendProbe:()=>sendDatagram(socket,candidateProbe(uid,token,2),peer)};}
   }
   if(fromServer&&p[8]===3&&p[9]===3&&p[10]===67&&p.length>=40){const tag=p.readUInt32LE(36);await sendDatagram(socket,relayAck(uid,token,tag),item.peer);keep=true;return {transport:makeIotcTransport(socket,queue,item.peer,token,tag)};}
  }
  throw Error('Rendezvous timed out');
 }finally{if(!keep)await closeSocket(socket);}
}
