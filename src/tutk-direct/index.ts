/** Direct TUTK client, one operation and one explicitly owned connection.
 * No credentials are logged or persisted. Wire references are documented in
 * the individual protocol modules; no vendor library or network helper. */
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {openLanIotc,type IotcTransport} from './iotc.js';
import {openRelayIotc} from './relay.js';
import {connectDtls,type DtlsSession} from './dtls.js';
import {runAvSession,type AvOperation} from './av.js';
import {makeControlRequest} from './ctrl.js';
import {MutationHandoff,MutationFailure,UploadRejected,type MutationReceipt,type prepareUpload} from './mutations.js';

export type DirectRequest={session:{uid:string;authkey:string;passwd:string;region:string;device:string};operation:'camera'|'list'|'download'|'delete'|'upload';confirm?:true;onHandoff?:()=>void;onUploadAck?:()=>void;assertAuthority?:()=>void|Promise<void>;assertAuthoritySync?:()=>void;job?:ReturnType<typeof prepareUpload>;kind?:'model'|'video'|'timelapse';storage?:string;path?:string;expectedSize?:number};
export type DirectResult={kind:'upload';receipt:MutationReceipt;actualPath:string|null}|{kind:'delete';receipt:MutationReceipt}|{kind:'camera';jpeg:Buffer}|{kind:'download';bytes:Buffer;size:number;md5:string}|{kind:'list';files:Array<{name?:string;path?:string;size?:number;time?:number;date?:string;type:'model'|'video'|'timelapse'}>};
export type DirectStage='validation'|'discovery'|'rendezvous'|'handshake'|'auth'|'transfer'|'cancel';
export class DirectTutkError extends Error {readonly code:string;constructor(readonly stage:DirectStage){super(`Direct TUTK operation failed (${stage}).`);this.name='DirectTutkError';this.code=`DIRECT_TUTK_${stage.toUpperCase()}`;}}
function fail():never{throw Error('Invalid TUTK response');}
export async function decodeCameraFrames(frames:Buffer[],signal:AbortSignal):Promise<Buffer>{
 const input=Buffer.concat(frames),format=input[0]===255&&input[1]===216?'mjpeg':'h264';if(!input.length||input.length>16*1024*1024) return fail();
 const child=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-max_alloc','67108864','-f',format,'-i','pipe:0','-frames:v','1','-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['pipe','pipe','ignore']});
 let output:Buffer[]=[];let size=0,invalid=false;child.stdin.on('error',()=>{});child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>4*1024*1024){invalid=true;child.kill('SIGKILL');}else output.push(b);});
 const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const timer=setTimeout(abort,10000);
 try {const result=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);child.stdin.end(input);});const image=Buffer.concat(output);output=[];if(signal.aborted||result!==0||invalid||image.length<4||image[0]!==255||image[1]!==216||image.at(-2)!==255||image.at(-1)!==217)return fail();return image;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
function projectFiles(op:Exclude<AvOperation,{operation:'camera'}>,value:unknown):DirectResult{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();const v=value as Record<string,unknown>;
 if(op.operation==='upload'){const r=v.uploadReceipt as Record<string,unknown>;if(!r||!['verified','uploaded_unverified'].includes(String(r.status))||v.path!==null&&typeof v.path!=='string')return fail();return {kind:'upload',receipt:{status:r.status as 'verified'|'uploaded_unverified',operation:'upload',path:op.job.remoteName,retryable:false,...(op.storage==='emmc'?{historyEffectsUncertain:true}:{}),historyRotationAllowed:op.storage==='emmc',sha256:op.job.sha256,md5:op.job.md5,size:op.job.size,...(r.reason?{reason:String(r.reason)}:{})},actualPath:v.path as string|null};}
 if(op.operation==='delete'){if(!Number.isSafeInteger(v.deleteResult))return fail();return {kind:'delete',receipt:{status:v.deleteResult===0?'acknowledged':'rejected',operation:'delete',path:op.path,retryable:false}};}
 if(op.operation==='download'){
  if(!Buffer.isBuffer(v.bytes))return fail();const bytes=v.bytes;
  if(bytes.length>16*1024*1024||v.size!==bytes.length||typeof v.md5!=='string'||!/^[a-f0-9]{32}$/.test(v.md5)||createHash('md5').update(bytes).digest('hex')!==v.md5)return fail();
  return {kind:'download',bytes,size:bytes.length,md5:v.md5};
 }
 if(!Array.isArray(v.replies)||v.replies.length>4096)return fail();const files:Extract<DirectResult,{kind:'list'}>['files']=[];
 for(const reply of v.replies){if(!reply||typeof reply!=='object'||!Array.isArray(reply.file_lists))return fail();for(const row of reply.file_lists){
  if(!row||typeof row!=='object'||Array.isArray(row)||files.length>=4096)return fail();const entry:Extract<DirectResult,{kind:'list'}>['files'][number]={type:op.kind};
  for(const k of ['name','path','date'] as const){if(row[k]!==undefined){if(typeof row[k]!=='string'||row[k].length>4096||/[\x00-\x1f\x7f]/.test(row[k]))return fail();entry[k]=row[k];}}
  for(const k of ['size','time'] as const){if(row[k]!==undefined){if(typeof row[k]!=='number'||!Number.isSafeInteger(row[k])||row[k]<0)return fail();entry[k]=row[k];}}
  if(!entry.name&&!entry.path)return fail();files.push(entry);
 }}return {kind:'list',files};
}
type DirectDependencies={openLan:typeof openLanIotc;openRelay:typeof openRelayIotc;connect:typeof connectDtls;av:typeof runAvSession;decode:typeof decodeCameraFrames};
const defaults:DirectDependencies={openLan:openLanIotc,openRelay:openRelayIotc,connect:connectDtls,av:runAvSession,decode:decodeCameraFrames};
/** Callers own account/ticket acquisition; this function owns all media network state. */
export async function runDirectTutk(request:DirectRequest,signal?:AbortSignal):Promise<DirectResult>{return runDirectTutkForTest(request,signal,defaults);}
/** Injected dependencies are for isolated lifecycle tests only. */
export async function runDirectTutkForTest(request:DirectRequest,signal:AbortSignal|undefined,deps:DirectDependencies):Promise<DirectResult>{
 let stage:DirectStage='validation';const s=request?.session?{...request.session}:undefined;
 if(!s||!/^[A-Za-z0-9]{20}$/.test(s.uid)||!/^[\x21-\x7e]{1,256}$/.test(s.authkey)||typeof s.passwd!=='string'||!s.passwd||Buffer.byteLength(s.passwd)>256||!['us','eu','cn'].includes(s.region)||!/^[A-Za-z0-9_-]{1,128}$/.test(s.device))throw new DirectTutkError(stage);
 let operation:AvOperation;
 if(request.operation==='camera')operation={operation:'camera'};
 else if(request.operation==='list'&&request.kind&&['model','video','timelapse'].includes(request.kind)&&(request.storage===undefined||typeof request.storage==='string'))operation={operation:'list',kind:request.kind,storage:request.storage??''};
 else if(request.operation==='download'&&typeof request.path==='string')operation={operation:'download',path:request.path};
 else if(request.operation==='upload'&&request.job&&(request.storage==='emmc'||request.storage==='udisk'))operation={operation:'upload',job:request.job,storage:request.storage};
 else if(request.operation==='delete'&&typeof request.path==='string'&&request.confirm===true&&request.kind&&['model','video','timelapse'].includes(request.kind))operation={operation:'delete',path:request.path,confirm:true,kind:request.kind!,storage:request.storage??'',...(request.expectedSize!==undefined?{expectedSize:request.expectedSize}:{})};
 else throw new DirectTutkError(stage);
 try{if(operation.operation!=='camera'&&operation.operation!=='upload')makeControlRequest(operation);}catch{throw new DirectTutkError(stage);}
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const deadline=performance.now()+60000,timer=setTimeout(abort,60000);
 const mutation=operation.operation==='delete'?new MutationHandoff('delete',operation.path):operation.operation==='upload'?new MutationHandoff('upload',operation.job.remoteName,{sha256:operation.job.sha256,md5:operation.job.md5,size:operation.job.size,historyRotationAllowed:operation.storage==='emmc'}):undefined;let uploadAck=false;
 let transport:IotcTransport|undefined,dtls:DtlsSession|undefined,pump:Promise<void>|undefined,callback:((b:Buffer)=>void)|undefined;const inFlight=new Set<Promise<void>>();
 try{
  stage='discovery';let probe:(()=>Promise<void>)|undefined;
  try{transport=await deps.openLan(s.uid,s.authkey,controller.signal);}catch{controller.signal.throwIfAborted();stage='rendezvous';const remote=await deps.openRelay(s,controller.signal);transport=remote.transport;probe=remote.sendProbe;}
  stage='handshake';dtls=await deps.connect(transport,s.passwd,{deadline,signal:controller.signal,sendProbe:probe});
  const active=dtls;stage='auth';
  const channel={authorize:async()=>{await request.assertAuthority?.();},verify:()=>request.assertAuthoritySync?.(),send:(b:Buffer)=>{const pending=active.send(b);inFlight.add(pending);void pending.finally(()=>inFlight.delete(pending)).catch(()=>{});return pending;},onData:(f:(b:Buffer)=>void)=>{callback=f;return()=>{callback=undefined;};}};
  pump=(async()=>{try{while(!controller.signal.aborted){const b=await active.receive(performance.now()+500);if(b)callback?.(b);}}catch{if(!controller.signal.aborted)controller.abort();}})();
  const result=await deps.av(channel,s.passwd,operation,controller.signal,()=>{stage='transfer';},s.uid,()=>{request.onHandoff?.();mutation?.beforeSend();},()=>{uploadAck=true;request.onUploadAck?.();});stage='transfer';
  if(result.kind==='camera')return {kind:'camera',jpeg:await deps.decode(result.frames,controller.signal)};
  if(operation.operation==='camera')return fail();stage='validation';return projectFiles(operation,result.value);
 }catch(error){if(mutation){if(error instanceof UploadRejected)throw new MutationFailure(mutation.receipt('rejected','printer_refused'));if(uploadAck)throw new MutationFailure(mutation.receipt('uploaded_unverified','readback_failed'));throw mutation.failure();}throw new DirectTutkError(signal?.aborted?'cancel':stage);}
 finally{const cancelled=controller.signal.aborted;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();dtls?.close();if(cancelled&&transport){await transport.close(false);transport=undefined;}if(pump)await pump.catch(()=>{});await Promise.allSettled([...inFlight]);if(transport)await transport.close(!signal?.aborted);}
}
