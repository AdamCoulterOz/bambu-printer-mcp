/** Source-backed FILE_UPLOAD and FILE_DEL wire builders. No transport or retry. */
import {createHash,randomBytes} from 'node:crypto';
const MAX_UPLOAD=16*1024*1024;
function validPath(path:string):boolean{return typeof path==='string'&&path.startsWith('/')&&Buffer.byteLength(path)<=1024&&!/[\x00-\x1f\x7f*?\[\]]/.test(path)&&!path.split('/').some(x=>x==='..'||x==='.');}
export function deleteRequest(path:string,confirm:boolean,sequence=1):Buffer{
 if(confirm!==true||!validPath(path)||path.endsWith('/')||!Number.isSafeInteger(sequence)||sequence<0||sequence>0xffffffff)throw Error('Invalid delete request');
 const bytes=Buffer.from(JSON.stringify({cmdtype:3,sequence,req:{paths:[path]}}));if(bytes.length>1020)throw Error('Delete request too long');return bytes;
}
export function correlatedMutationReply(value:unknown,command:3|5,sequence:number):number{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid mutation reply');const v=value as Record<string,unknown>;
 if(v.cmdtype!==command||v.sequence!==sequence||!Number.isSafeInteger(v.result))throw Error('Unmatched mutation reply');return v.result as number;
}
export function prepareUpload(source:Buffer,name:string,storage:'emmc'|'udisk',allowHistoryRotation:boolean,sequence=1,externalCapabilityVerified=false){
 if(!Buffer.isBuffer(source)||source.length===0||source.length>MAX_UPLOAD||!['emmc','udisk'].includes(storage)||storage==='emmc'&&allowHistoryRotation!==true||storage==='udisk'&&externalCapabilityVerified!==true||typeof name!=='string'||!/^[-A-Za-z0-9_ .]{1,180}$/.test(name)||name==='.'||name==='..'||!Number.isSafeInteger(sequence)||sequence<0||sequence>0xffffffff)throw Error('Invalid upload request');
 const bytes=Buffer.from(source),dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
 const remoteName=`${stem}-${randomBytes(16).toString('hex')}${ext}`,md5=createHash('md5').update(bytes).digest('hex'),sha256=createHash('sha256').update(bytes).digest('hex');
 const init=Buffer.from(JSON.stringify({mtype:12289,cmdtype:5,sequence,req:{type:'model',storage,path:remoteName,total:bytes.length}}));
 return {remoteName,size:bytes.length,md5,sha256,init,chunks(chunkKiB:number,offset:number):Buffer[]{
  if(!Number.isSafeInteger(chunkKiB)||chunkKiB<1||chunkKiB>31||offset!==0)throw Error('Invalid upload initialization');
  const chunkSize=chunkKiB*1024,result:Buffer[]=[];
  for(let at=0,id=0;at<bytes.length;at+=chunkSize,id++){
   const body=bytes.subarray(at,Math.min(bytes.length,at+chunkSize));const req:Record<string,unknown>={frag_id:id,offset:at,size:body.length};if(at+body.length===bytes.length)req.file_md5=md5;
   result.push(Buffer.concat([Buffer.from(JSON.stringify({mtype:12289,cmdtype:5,sequence,req})+'\n\n'),body]));
  }return result;
 }};
}

export class UploadRejected extends Error {}
/** One-shot upload receipt state; caller owns I/O and must never replay a handoff. */
export class UploadReceipt {
 private stage:'init'|'sending'|'verify'|'done'='init';
 constructor(private readonly job:ReturnType<typeof prepareUpload>,private readonly sequence=1){}
 initialized(value:unknown):Buffer[] {
  if(this.stage!=='init')throw Error('Invalid upload state');const result=correlatedMutationReply(value,5,this.sequence);
  if(result!==1)throw new UploadRejected(result===19?'Upload target already exists':'Upload init rejected');
  const v=value as {reply?:{chunk_size?:unknown;offset?:unknown}};
  const chunks=this.job.chunks(v.reply?.chunk_size as number,v.reply?.offset as number);this.stage='sending';return chunks;
 }
 completed(value:unknown):void {
  if(this.stage!=='sending')throw Error('Invalid upload state');if(correlatedMutationReply(value,5,this.sequence)!==0)throw new UploadRejected('Upload completion rejected');this.stage='verify';
 }
 verified(bytes:Buffer):{status:'verified';size:number;sha256:string;md5:string}{
  if(this.stage!=='verify'||!Buffer.isBuffer(bytes)||bytes.length!==this.job.size||createHash('sha256').update(bytes).digest('hex')!==this.job.sha256||createHash('md5').update(bytes).digest('hex')!==this.job.md5)throw Error('Upload readback mismatch');
  this.stage='done';return {status:'verified',size:bytes.length,sha256:this.job.sha256,md5:this.job.md5};
 }
 unreadable():{status:'uploaded_unverified';reason:'readback_unavailable'}{
  if(this.stage!=='verify')throw Error('Invalid upload state');this.stage='done';return {status:'uploaded_unverified',reason:'readback_unavailable'};
 }
}

export type MutationReceipt = {status:'not_sent'|'rejected'|'acknowledged'|'uploaded_unverified'|'verified'|'unknown';operation:'upload'|'delete';path:string;retryable:false;historyEffectsUncertain?:boolean;fileEffectsUncertain?:boolean;historyRotationAllowed?:boolean;sha256?:string;md5?:string;size?:number;reason?:string};
export class MutationFailure extends Error {
 constructor(readonly receipt:MutationReceipt){super(`Remote ${receipt.operation} ${receipt.status}`);this.name='MutationFailure';}
}
/** The mutation marker is set synchronously before effectful I/O and cannot reset. */
export class MutationHandoff {
 private sent=false;
 constructor(private readonly operation:'upload'|'delete',private readonly path:string,private readonly digest?:{sha256:string;md5:string;size:number;historyRotationAllowed?:boolean}){}
 beforeSend():void{if(this.sent)throw new Error('Mutation handoff already marked');this.sent=true;}
 receipt(status:'rejected'|'acknowledged'|'uploaded_unverified'|'verified'|'unknown'|'not_sent',reason?:string):MutationReceipt {
  if((status==='not_sent')===this.sent)throw new Error('Invalid handoff status');
  return {status,operation:this.operation,path:this.path,retryable:false,...this.digest,...(this.operation==='upload'&&this.sent&&this.digest?.historyRotationAllowed?{historyEffectsUncertain:true}:{}),...(this.operation==='upload'&&this.sent&&(status==='unknown'||status==='rejected')?{fileEffectsUncertain:true}:{}),...(reason?{reason}:{})};
 }
 failure():MutationFailure{return new MutationFailure(this.receipt(this.sent?'unknown':'not_sent'));}
}
