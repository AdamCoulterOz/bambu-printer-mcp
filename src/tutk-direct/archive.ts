/** Bounded archive inspection for bytes already downloaded and checksum-verified. */
import {loadSafe3mfArchive} from '../safety/archive.js';
const MAX_ARCHIVE = 16 * 1024 * 1024, MAX_EXPANDED = 32 * 1024 * 1024, MAX_MEMBER = 8 * 1024 * 1024, MAX_ENTRIES = 2048;
function fail(): never { throw new Error('Invalid or oversized remote archive'); }
function preflight(bytes: Buffer): void {
 if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE || bytes.length < 22) fail();
 let end = -1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0)fail(); const count=bytes.readUInt16LE(end+10), start=bytes.readUInt32LE(end+16), size=bytes.readUInt32LE(end+12);
 if(count>MAX_ENTRIES || start+size!==end)fail(); let pos=start,total=0;
 for(let i=0;i<count;i++){
  if(pos+46>end || bytes.readUInt32LE(pos)!==0x02014b50)fail();
  const expanded=bytes.readUInt32LE(pos+24), mode=bytes.readUInt32LE(pos+38)>>>16, platform=bytes[pos+5], nameLength=bytes.readUInt16LE(pos+28);
  if(pos+46+nameLength>end)fail();let name:string;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(pos+46,pos+46+nameLength));}catch{fail();}
  if(/^[A-Za-z]:/.test(name!)||/[\x00-\x1f\x7f]/.test(name!))fail();
  if(expanded>MAX_MEMBER || (total+=expanded)>MAX_EXPANDED || (platform===3 && (mode&0xf000)===0xa000))fail();
  pos+=46+bytes.readUInt16LE(pos+28)+bytes.readUInt16LE(pos+30)+bytes.readUInt16LE(pos+32);if(pos>end)fail();
 }
 if(pos!==end)fail();
}
export async function inspectRemoteArchive(bytes:Buffer, member?:string):Promise<{entries:string[];bytes?:Buffer}>{
 preflight(bytes);const zip=await loadSafe3mfArchive(bytes);const entries=Object.values(zip.files).filter(x=>!x.dir).map(x=>x.name);
 if(member===undefined)return {entries};
 if(typeof member!=='string'||!entries.includes(member))fail();
 const file=zip.file(member);if(!file)fail();return {entries,bytes:await file.async('nodebuffer')};
}
