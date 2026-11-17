import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,writeFileSync,readFileSync,lstatSync,renameSync,unlinkSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {withPrivateLock} from './private-lock.js';

type Hold={version:1;serial:string;nonce:string;created:number;taskId?:string};
function directory(serial:string):string {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(serial))throw new Error('A printer serial is required.');
  const root=process.env.BAMBU_RESUME_STATE_DIR || join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(),'.config'),'bambu-printer-mcp','resume');
  return join(root,'reference-holds',createHash('sha256').update(serial.toUpperCase()).digest('hex'));
}
function syncDir(dir:string):void {const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function read(dir:string,serial:string):Hold|undefined {
  const file=join(dir,'hold.json');
  try {
    const st=lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid())||st.size>2048)throw new Error();
    const value=JSON.parse(readFileSync(file,'utf8')) as Hold;
    if(value.version!==1||value.serial!==serial.toUpperCase()||!/^[-a-f0-9]{36}$/.test(value.nonce)||!Number.isSafeInteger(value.created)||value.created<0||value.taskId!==undefined&&!/^[1-9]\d{0,19}$/.test(value.taskId))throw new Error();
    return value;
  } catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw new Error('Printer reference hold is unavailable or invalid; manual recovery is required.');}
}
function write(dir:string,hold:Hold):void {
  const temp=join(dir,`.hold-${randomUUID()}`);let fd:number|undefined;
  try {fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,JSON.stringify(hold));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,join(dir,'hold.json'));syncDir(dir);}
  finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
}
function remove(dir:string):void {try{unlinkSync(join(dir,'hold.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}syncDir(dir);}

/** The OS lock serializes starts across processes sharing this private state. */
export async function withPrintStartGuard<T>(serial:string,fn:()=>Promise<T>):Promise<T> {
  const dir=directory(serial);
  return withPrivateLock(dir,async()=>{if(read(dir,serial))throw new Error('A previous reference print remains pending or uncertain; inspect printer and history before recovery.');return fn();});
}
/** Call under withPrintStartGuard, synchronously before transport handoff. */
export function markReferenceUnknown(serial:string):string {const dir=directory(serial);if(read(dir,serial))throw new Error('A previous reference print remains pending or uncertain.');const nonce=randomUUID();write(dir,{version:1,serial:serial.toUpperCase(),nonce,created:Date.now()});return nonce;}
export function discardUnsentReferenceHold(serial:string,nonce:string):void {const dir=directory(serial),hold=read(dir,serial);if(!hold||hold.nonce!==nonce||hold.taskId)throw new Error('Reference hold changed before dispatch.');remove(dir);}
/** Call under the same print guard; failure leaves the durable unknown hold. */
export function bindReferenceTask(serial:string,id:string):void {const dir=directory(serial),hold=read(dir,serial);if(!hold||hold.taskId||!/^[1-9]\d{0,19}$/.test(id))throw new Error('Reference hold cannot be bound.');write(dir,{...hold,taskId:id});}
export async function inspectReferenceHold(serial:string):Promise<{state:'none'|'unknown'|'pending';taskId?:string;nonce?:string}> {
  const dir=directory(serial);return withPrivateLock(dir,async()=>{const h=read(dir,serial);return !h?{state:'none'}:h.taskId?{state:'pending',taskId:h.taskId,nonce:h.nonce}:{state:'unknown',nonce:h.nonce};});
}
/** Caller supplies a fresh observed-serial report acquired without holding this lock. */
export async function observeReferenceHold(serial:string,status:any):Promise<'none'|'unknown'|'pending'> {
  const dir=directory(serial);return withPrivateLock(dir,async()=>{
    const hold=read(dir,serial);if(!hold)return 'none';if(!hold.taskId)return 'unknown';
    const o=status?.observation,raw=status?.raw,now=Date.now();
    if(status?.connected!==true||status.serial!==serial||o?.source!=='mqtt'||!Number.isFinite(o.requestedAt)||!Number.isFinite(o.receivedAt)||o.requestedAt<hold.created||o.receivedAt<o.requestedAt||o.receivedAt>now||now-o.requestedAt>15000||!raw)throw new Error('A fresh observed printer report is required.');
    const task=typeof raw.task_id==='string'?raw.task_id:typeof raw.task_id==='number'&&Number.isSafeInteger(raw.task_id)?String(raw.task_id):'';
    if(task!==hold.taskId)return 'pending';
    // The collector does not expose a stable MQTT connection epoch. Even a
    // matching active-then-terminal sequence cannot prove both observations
    // belong to the same connection lifecycle, so retain the durable hold.
    return 'pending';
  });
}
/** Explicit human recovery checks the exact hold observed before confirmation. */
export async function clearReferenceHold(serial:string,nonce:string,withAuthority:(removeHold:()=>void)=>Promise<void>,signal?:AbortSignal):Promise<void> {
  const dir=directory(serial);await withPrivateLock(dir,async()=>{const hold=read(dir,serial);if(!hold||hold.nonce!==nonce)throw new Error('Printer reference hold changed; review it again.');signal?.throwIfAborted();let removed=false;await withAuthority(()=>{signal?.throwIfAborted();remove(dir);removed=true;});if(!removed)throw new Error('Printer reference hold was not cleared.');},signal);
}
