/** Direct private TUTK orchestration. No credentials are exposed to callers. */
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CloudMqttCredentials } from './account/index.js';
import {MutationFailure,MutationHandoff,prepareUpload,type MutationReceipt} from './tutk-direct/mutations.js';
import { createHttpProof, handyClientHeaders } from './signing/http-proof.js';

export type TutkOperation = {operation:'camera'} | {operation:'list';kind:'model'|'video'|'timelapse';storage:''|'internal'|'external'|'emmc'|'udisk'|'sdcard'|'usb'} | {operation:'download';path:string} | {operation:'delete';path:string;confirm:true;kind:'model'|'video'|'timelapse';storage:''|'internal'|'external'|'emmc'|'udisk'|'sdcard'|'usb';expectedSize?:number} | {operation:'upload';bytes:Buffer;name:string;storage:'emmc'|'udisk';allowHistoryRotation:boolean;externalCapabilityVerified?:boolean};
type Session = {uid:string;authkey:string;passwd:string;region:string;device:string};
type DirectRequest = TutkOperation & {session:Session;onHandoff?:()=>void;onUploadAck?:()=>void;assertAuthority?:()=>void|Promise<void>;assertAuthoritySync?:()=>void;job?:ReturnType<typeof prepareUpload>};
type Dependencies = {
  credentials(serial:string):Promise<CloudMqttCredentials>;
  fetch?:typeof fetch;
  proof?:typeof createHttpProof;
  headers?:typeof handyClientHeaders;
  onLockChild?: (pid:number)=>void;
  execute?: (request:DirectRequest, signal:AbortSignal)=>Promise<TutkResult>;
};
export type RemoteMediaStage = 'lock'|'account'|'proof'|'ticket'|'direct'|'validation';
/** Deliberately excludes the underlying cause, endpoint, and credential-bearing data. */
export class RemoteMediaError extends Error {
  readonly code: string;
  constructor(readonly stage:RemoteMediaStage) {
    super(`Remote camera or file operation failed (${stage}).`);
    this.name='RemoteMediaError'; this.code=`REMOTE_MEDIA_${stage.toUpperCase()}`;
  }
}
function fail(): never { throw new Error('Remote camera or file operation failed.'); }
function object(value:unknown): value is Record<string,unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
async function boundedJson(response:Response, max:number):Promise<unknown> {
  if (!response.ok || !response.body) return fail();
  const declared=response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>max)) return fail();
  const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try { while(true) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>max) return fail(); chunks.push(part.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
}
export type TutkResult = {kind:'upload';receipt:MutationReceipt;actualPath:string|null} | {kind:'delete';receipt:MutationReceipt} | {kind:'camera';jpeg:Buffer} | {kind:'download';bytes:Buffer;size:number;md5:string} | {kind:'list';files:Array<{name?:string;path?:string;size?:number;time?:number;date?:string;type:'model'|'video'|'timelapse'}>};
function projectResult(operation:TutkOperation, value:unknown, job?:ReturnType<typeof prepareUpload>):TutkResult {
  if (!object(value) || value.kind !== operation.operation) return fail();
  if (operation.operation === 'upload') {
    if(!job||!object(value.receipt)||!['verified','uploaded_unverified'].includes(String(value.receipt.status))||value.receipt.operation!=='upload'||value.receipt.retryable!==false||value.receipt.path!==job.remoteName||value.receipt.sha256!==job.sha256||value.receipt.md5!==job.md5||value.receipt.size!==job.size||value.actualPath!==null&&(typeof value.actualPath!=='string'||!value.actualPath.startsWith('/')||value.actualPath.split('/').at(-1)!==job.remoteName)||value.receipt.status==='verified'&&value.actualPath===null)return fail();
    const status=value.receipt.status as 'verified'|'uploaded_unverified';return {kind:'upload',receipt:{status,operation:'upload',path:job.remoteName,retryable:false,...(operation.storage==='emmc'?{historyEffectsUncertain:true}:{}),historyRotationAllowed:operation.storage==='emmc',sha256:job.sha256,md5:job.md5,size:job.size,...(status==='uploaded_unverified'?{reason:'readback_unavailable'}:{})},actualPath:value.actualPath as string|null};
  }
  if (operation.operation === 'delete') {
    if(!object(value.receipt)||!['acknowledged','rejected'].includes(String(value.receipt.status))||value.receipt.operation!=='delete'||value.receipt.path!==operation.path||value.receipt.retryable!==false)return fail();
    return {kind:'delete',receipt:{status:value.receipt.status as 'acknowledged'|'rejected',operation:'delete',path:operation.path,retryable:false}};
  }
  if (operation.operation === 'list') {
    if (!Array.isArray(value.files) || value.files.length > 4096) return fail();
    const files:Extract<TutkResult,{kind:'list'}>['files']=[];
    for (const row of value.files) {
      if (!object(row) || row.type !== operation.kind) return fail();
      const entry:Extract<TutkResult,{kind:'list'}>['files'][number]={type:operation.kind};
      for (const key of ['name','path','date'] as const) {
        const v=row[key]; if(v!==undefined) { if(typeof v!=='string' || v.length>4096 || /[\x00-\x1f\x7f]/.test(v)) return fail(); entry[key]=v; }
      }
      for (const key of ['size','time'] as const) {
        const v=row[key]; if(v!==undefined) { if(typeof v!=='number' || !Number.isSafeInteger(v) || v<0) return fail(); entry[key]=v; }
      }
      if (!entry.name && !entry.path) return fail();
      files.push(entry);
    }
    return {kind:'list',files};
  }
  if (operation.operation === 'camera') {
    const bytes=value.jpeg;
    if (!Buffer.isBuffer(bytes) || bytes.length<4 || bytes.length>4*1024*1024 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes.at(-2)!==0xff || bytes.at(-1)!==0xd9) return fail();
    return {kind:'camera',jpeg:bytes};
  }
  const bytes=value.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length>16*1024*1024 || value.size!==bytes.length || typeof value.md5!=='string' || !/^[a-f0-9]{32}$/.test(value.md5) || createHash('md5').update(bytes).digest('hex')!==value.md5) return fail();
  return {kind:'download',bytes,size:bytes.length,md5:value.md5};
}

/** Pre-created, stable, shared inode; only a non-secret group-writable file belongs here. */
async function acquireOperationLock(path:string, signal:AbortSignal, onChild?:(pid:number)=>void):Promise<{child:ChildProcessWithoutNullStreams; check:()=>Promise<void>; close:()=>Promise<void>}> {
  if (!isAbsolute(path) || typeof constants.O_NOFOLLOW!=='number') return fail();
  const file=await open(path,constants.O_RDWR|constants.O_NOFOLLOW);let child:ChildProcessWithoutNullStreams|undefined,closed:Promise<void>|undefined;
  try {
    const initial=await file.stat({bigint:true}), named=await lstat(path,{bigint:true});
    if(!initial.isFile()||initial.nlink!==1n||(initial.mode&7n)!==0n||initial.dev!==named.dev||initial.ino!==named.ino)return fail();
    const script=`import fcntl,os,stat,sys
p=sys.argv[1]
f=3
s=os.fstat(f)
if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_mode & 7 or str(s.st_dev)!=sys.argv[2] or str(s.st_ino)!=sys.argv[3]: sys.exit(1)
fcntl.flock(f,fcntl.LOCK_EX)
t=os.stat(p,follow_symlinks=False)
if (s.st_dev,s.st_ino)!=(t.st_dev,t.st_ino): sys.exit(1)
sys.stdout.write("READY\\n"); sys.stdout.flush()
sys.stdin.buffer.read()
`;
    child=spawn('python3',['-c',script,path,String(initial.dev),String(initial.ino)],{stdio:['pipe','pipe','pipe',file.fd]}) as ChildProcessWithoutNullStreams;
    const active=child;active.stdin.on('error',()=>{});active.stderr.resume();
    closed=new Promise<void>(resolve=>{active.once('close',()=>resolve());});
    if(active.pid)onChild?.(active.pid);
    await new Promise<void>((resolve,reject)=>{
      let done=false;const timer=setTimeout(()=>finish(false),15_000);const abort=()=>finish(false);
      const finish=(ok:boolean)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(ok)resolve();else{active.kill('SIGKILL');reject(Error('lock unavailable'));}};
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return finish(false);
      active.stdout.once('data',v=>finish(v.toString()==='READY\n'));active.once('error',()=>finish(false));active.once('exit',()=>finish(false));
    });
    const check=async()=>{if(active.exitCode!==null||active.signalCode!==null)return fail();const current=await lstat(path,{bigint:true});if(!current.isFile()||current.nlink!==1n||current.dev!==initial.dev||current.ino!==initial.ino||(current.mode&7n)!==0n)return fail();};
    const close=async()=>{active.stdin.end();const timer=setTimeout(()=>active.kill('SIGKILL'),1000);try{await closed!;}finally{clearTimeout(timer);await file.close();}};
    return {child:active,check,close};
  } catch(error) {
    if(child){child.kill('SIGKILL');if(closed)await closed;}
    await file.close();throw error;
  }
}

/** A fresh ticket authorizes one direct read; no MQTT watcher or duplicate prepare. */
export async function runTutkOperation(options:{serial:string; signingDirectory:string; stateDirectory:string; osVersion:string; lockFile:string; operation:TutkOperation; signal?:AbortSignal}, deps:Dependencies):Promise<TutkResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.serial)) {if(options.operation.operation==='delete'||options.operation.operation==='upload')throw new MutationFailure({status:'not_sent',operation:options.operation.operation,path:options.operation.operation==='delete'?options.operation.path:options.operation.name,retryable:false});throw new RemoteMediaError('validation');}
  let job:ReturnType<typeof prepareUpload>|undefined;
  if(options.operation.operation==='upload'){try{job=prepareUpload(options.operation.bytes,options.operation.name,options.operation.storage,options.operation.allowHistoryRotation,1,options.operation.externalCapabilityVerified===true)}catch{throw new MutationFailure({status:'not_sent',operation:'upload',path:options.operation.name,retryable:false})}}
  const controller=new AbortController(), abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true}); if(options.signal?.aborted) abort();
  const timer=setTimeout(abort,90_000); let stage:RemoteMediaStage='lock'; let lock:Awaited<ReturnType<typeof acquireOperationLock>>|undefined; let receivedMutation=false,uploadAck=false;
  const mutation=options.operation.operation==='delete'?new MutationHandoff('delete',options.operation.path):job?new MutationHandoff('upload',job.remoteName,{sha256:job.sha256,md5:job.md5,size:job.size,historyRotationAllowed:options.operation.operation==='upload'&&options.operation.storage==='emmc'}):undefined;
  const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(new Error('cancelled')); if(controller.signal.aborted) return stop();
    controller.signal.addEventListener('abort',stop,{once:true}); promise.then(v=>{controller.signal.removeEventListener('abort',stop);resolve(v)},e=>{controller.signal.removeEventListener('abort',stop);reject(e)});
  });
  try {
    lock=await acquireOperationLock(options.lockFile,controller.signal,deps.onLockChild); lock.child.once('exit',abort); await wait(lock.check());
    stage='account'; const credentials=await wait(deps.credentials(options.serial));
    const broker=new URL(credentials.url);
    if(broker.protocol!=='mqtts:' || broker.username || broker.password || broker.search || broker.hash || (broker.pathname && broker.pathname!=='/') || broker.port!=='8883') return fail();
    const host=(broker.hostname==='us.mqtt.bambulab.com' || broker.hostname==='eu.mqtt.bambulab.com')?'https://api.bambulab.com':broker.hostname==='cn.mqtt.bambulab.com'?'https://api.bambulab.cn':undefined;
    if(!host) return fail();
    stage='proof'; const [proof,headers]=await wait(Promise.all([(deps.proof??createHttpProof)(options.signingDirectory),(deps.headers??handyClientHeaders)(options.stateDirectory,options.osVersion)]));
    stage='account'; await wait(credentials.assertCurrent()); credentials.assertGenerationCurrent();
    stage='lock'; await wait(lock.check()); controller.signal.throwIfAborted();
    stage='ticket'; const response=await wait((deps.fetch??fetch)(host+'/v1/iot-service/api/user/ttcode',{method:'POST',redirect:'error',signal:controller.signal,headers:{...headers,...proof,'content-type':'application/json',authorization:`Bearer ${credentials.password}`},body:JSON.stringify({dev_id:options.serial,protocols:['tutk']})}));
    const value=await wait(boundedJson(response,64*1024));
    if(!object(value) || (value.code!==undefined && value.code!==null) || (value.error!==undefined && value.error!==null && value.error!=='') || (value.type!==undefined && value.type!=='' && (typeof value.type!=='string' || value.type.toLowerCase()!=='tutk'))) return fail();
    const uid=value.ttcode??value.uid, {authkey,passwd,region}=value;
    if (![uid,authkey,passwd,region].every(v=>typeof v==='string' && v.length>0 && v.length<=256 && !/[\x00-\x20\x7f]/.test(v))) return fail();
    stage='account'; await wait(credentials.assertCurrent()); credentials.assertGenerationCurrent();
    stage='lock'; await wait(lock.check()); controller.signal.throwIfAborted();
    stage='direct';
    const modulePath='./tutk-direct/index.js';
    const execute=deps.execute ?? (await import(modulePath)).runDirectTutk as (request:DirectRequest,signal:AbortSignal)=>Promise<TutkResult>;
    // Do not race direct execution with abort: it must settle only after closing
    // its transport, while this process still owns the shared operation lock.
    const guardTimer=setInterval(()=>{try { credentials.assertGenerationCurrent(); } catch { controller.abort(); }},200);
    let valueOut:TutkResult;
    try { valueOut=await execute({...options.operation,session:{uid:uid as string,authkey:authkey as string,passwd:passwd as string,region:region as string,device:options.serial},...(mutation?{onHandoff:()=>{credentials.assertGenerationCurrent();controller.signal.throwIfAborted();mutation.beforeSend()},assertAuthority:async()=>{await wait(credentials.assertCurrent());await wait(lock!.check());},assertAuthoritySync:()=>{credentials.assertGenerationCurrent();controller.signal.throwIfAborted()}}:{}),...(job?{job,onUploadAck:()=>{uploadAck=true}}:{})},controller.signal); }
    finally { clearInterval(guardTimer); }
    if(mutation)receivedMutation=true;
    controller.signal.throwIfAborted(); await credentials.assertCurrent(); credentials.assertGenerationCurrent(); await lock.check();
    stage='validation'; return projectResult(options.operation,valueOut,job);
  } catch (error) {
    if(mutation){
      if(error instanceof MutationFailure)throw error;
      if(uploadAck)throw new MutationFailure(mutation.receipt('uploaded_unverified','readback_failed'));
      if(receivedMutation)throw new MutationFailure(mutation.receipt('unknown'));
      throw mutation.failure();
    }
    throw new RemoteMediaError(stage);
  }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort',abort); if(lock){lock.child.removeListener('exit',abort); await lock.close();} }
}

/** Read an archive once through the authenticated bounded download, then inspect
 * the immutable verified bytes locally; no printer mutation or extra ticket. */
export async function runRemoteArchive(options: Omit<Parameters<typeof runTutkOperation>[0], 'operation'> & {path:string;member?:string}, deps:Dependencies):Promise<{entries:string[];bytes?:Buffer}> {
  const {path,member,...base}=options;
  const result=await runTutkOperation({...base,operation:{operation:'download',path}},deps);
  if(result.kind!=='download')return fail();
  const {inspectRemoteArchive}=await import('./tutk-direct/archive.js');
  return inspectRemoteArchive(result.bytes,member);
}
