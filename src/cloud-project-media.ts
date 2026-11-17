/** Source-derived configuration 3MF candidate, not a cloud thumbnail receipt.
 * Studio 8e524a39d4c4cd0541801c1c46d2f77debb0bf1d:
 * GUI/Plater.cpp export_config_3mf; Format/bbs_3mf.cpp relationship exporter.
 * Call only with the same immutable bytes and hash used by print inspection.
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { parseStringPromise, Builder } from 'xml2js';
import { TextDecoder } from 'node:util';
import { loadSafe3mfArchive, MAX_PRINT_FILE_BYTES } from './safety/archive.js';
const MAX_XML = 2 * 1024 * 1024, MAX_PNG = 2 * 1024 * 1024, MAX_RESULT = 8 * 1024 * 1024;
const fail = (): never => { throw new Error('Cloud project configuration requires a bounded, unambiguous selected-plate preview and metadata.'); };
const crcTable = Uint32Array.from({length:256},(_,i)=>{let v=i;for(let n=0;n<8;n++)v=(v>>>1)^((v&1)?0xedb88320:0);return v>>>0;});
function crc32(b: Buffer): number { let v=0xffffffff;for(const x of b)v=(v>>>8)^crcTable[(v^x)&255];return (v^0xffffffff)>>>0; }
function png(data: Buffer): void {
  if (data.length < 57 || data.length > MAX_PNG || !data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return fail();
  let p=8, width=0,height=0,bpp=0,ihdr=false,end=false,parts:Buffer[]=[];
  while (p+12<=data.length) {
    const n=data.readUInt32BE(p); if(n>MAX_PNG || p+12+n>data.length) return fail();
    const type=data.toString('ascii',p+4,p+8), chunk=data.subarray(p+8,p+8+n);
    if (crc32(data.subarray(p+4,p+8+n))!==data.readUInt32BE(p+8+n)) return fail();
    if(type==='IHDR') { if(ihdr||p!==8||n!==13)return fail(); ihdr=true;width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);const color=chunk[9]; bpp=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]||0; if(!width||!height||width>4096||height>4096||chunk[8]!==8||!bpp||chunk[10]||chunk[11]||chunk[12])return fail(); }
    if(type==='IDAT') { if(!ihdr||end)return fail();parts.push(chunk); }
    if(type==='IEND') { if(n||!parts.length)return fail();end=true;p+=12+n;break; }
    p+=12+n;
  }
  if(!end||p!==data.length)return fail();
  const row=width*bpp+1, expected=row*height;if(expected>64*1024*1024)return fail();
  let raw:Buffer;try{raw=inflateSync(Buffer.concat(parts),{maxOutputLength:expected});}catch{return fail();}
  if(raw.length!==expected)return fail();for(let y=0;y<height;y++)if(raw[y*row]>4)return fail();
}
async function xml(data:Buffer):Promise<any> {
 if(data.length>MAX_XML||!data.length||data.includes(0)||/<!\s*(?:DOCTYPE|ENTITY)/i.test(data.toString('utf8')))return fail();
 try{return await parseStringPromise(new TextDecoder('utf-8',{fatal:true}).decode(data),{explicitArray:true,strict:true,explicitRoot:true});}catch{return fail();}
}
function selected(plates:any, key:string, plate:number):any {
 if(!Array.isArray(plates))return fail();
 const found=plates.filter(p=>Array.isArray(p?.metadata)&&p.metadata.some((m:any)=>m?.$?.key===key&&m.$.value===String(plate)));
 if(found.length!==1)return fail();
 const ids=found[0].metadata.filter((m:any)=>m?.$?.key===key);if(ids.length!==1)return fail();return found[0];
}
export async function buildCloudProjectMedia(snapshot:Buffer, plate:number, expectedSha256:string):Promise<{config3mf:Buffer; sha256:string; plate:number}> {
 if(!Buffer.isBuffer(snapshot)||!snapshot.length||snapshot.length>MAX_PRINT_FILE_BYTES||!Number.isSafeInteger(plate)||plate<1||plate>999||!/^[a-f0-9]{64}$/.test(expectedSha256)||createHash('sha256').update(snapshot).digest('hex')!==expectedSha256)return fail();
 const source=await loadSafe3mfArchive(snapshot);
 const read=async(name:string,limit:number)=>{const f=source.file(name);if(!f)return fail();const b=await f.async('nodebuffer');if(!b.length||b.length>limit)return fail();return b;};
 const images:Record<string,Buffer>={};for(const name of [`Metadata/plate_${plate}.png`,`Metadata/plate_${plate}_small.png`]){const b=await read(name,MAX_PNG);png(b);images[name]=b;}
 for(const name of [`Metadata/plate_no_light_${plate}.png`,`Metadata/top_${plate}.png`,`Metadata/pick_${plate}.png`])if(source.file(name)){const b=await read(name,MAX_PNG);png(b);images[name]=b;}
 const types=await read('[Content_Types].xml',MAX_XML);const parsedTypes=await xml(types);if(parsedTypes.Types?.$?.xmlns!=='http://schemas.openxmlformats.org/package/2006/content-types')return fail();
 const bboxName=`Metadata/plate_${plate}.json`;let bbox:Buffer|undefined;
 if(source.file(bboxName)){bbox=await read(bboxName,MAX_XML);try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bbox));if(!value||typeof value!=='object'||Array.isArray(value))return fail();}catch{return fail();}}
 const settings=await read('Metadata/project_settings.config',MAX_XML);try{const x=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(settings));if(!x||typeof x!=='object'||Array.isArray(x))return fail();}catch{return fail();}
 const model=await xml(await read('3D/3dmodel.model',MAX_XML));if(!model.model || !Array.isArray(model.model.resources)||model.model.resources.length!==1||!Array.isArray(model.model.build)||model.model.build.length!==1)return fail();
 model.model.resources=[{}]; model.model.build=[{}];
 const config=await xml(await read('Metadata/model_settings.config',MAX_XML));if(!config.config)return fail();
 const modelPlate=selected(config.config.plate,'plater_id',plate);
 const refs:Record<string,string>={thumbnail_file:`Metadata/plate_${plate}.png`,thumbnail_no_light_file:`Metadata/plate_no_light_${plate}.png`,top_file:`Metadata/top_${plate}.png`,pick_file:`Metadata/pick_${plate}.png`};
 for(const [key,name] of Object.entries(refs)){const matches=modelPlate.metadata.filter((m:any)=>m?.$?.key===key);if(matches.length>1 || (key==='thumbnail_file' && matches.length!==1) || (matches.length===1 && (matches[0].$.value!==name || !images[name])))return fail();}
 const retained={...modelPlate,metadata:modelPlate.metadata.filter((m:any)=>m?.$?.key!=='gcode_file')}; delete retained.model_instance;
 config.config={plate:[retained]};
 const slice=await xml(await read('Metadata/slice_info.config',MAX_XML));if(!slice.config)return fail();const slicePlate=selected(slice.config.plate,'index',plate);slice.config.plate=[slicePlate];
 const builder=new Builder({renderOpts:{pretty:false}}),zip=new JSZip();
 zip.file('[Content_Types].xml',types);if(bbox)zip.file(bboxName,bbox);zip.file('3D/3dmodel.model',builder.buildObject(model));zip.file('Metadata/project_settings.config',settings);zip.file('Metadata/model_settings.config',builder.buildObject(config));zip.file('Metadata/slice_info.config',builder.buildObject(slice));
 const image=`/Metadata/plate_${plate}.png`,small=`/Metadata/plate_${plate}_small.png`;
 zip.file('_rels/.rels',`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/><Relationship Target="${image}" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/><Relationship Target="${image}" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/><Relationship Target="${small}" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/></Relationships>`);
 for(const [name,data] of Object.entries(images))zip.file(name,data);
 const config3mf=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});if(config3mf.length>MAX_RESULT)return fail();
 return {config3mf,sha256:createHash('sha256').update(config3mf).digest('hex'),plate};
}
