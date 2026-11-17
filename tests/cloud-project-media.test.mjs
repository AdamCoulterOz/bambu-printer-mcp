import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {buildCloudProjectMedia} from '../dist/cloud-project-media.js';
const fixture = new URL('./fixtures/studio-02.08.02.61/two-plates-three-filaments-sliced.3mf',import.meta.url);
const hash = b => createHash('sha256').update(b).digest('hex');
test('Studio fixture produces selected-plate config projection with actual matching covers',async()=>{
 const input=await readFile(fixture), source=await JSZip.loadAsync(input), out=await buildCloudProjectMedia(input,2,hash(input)), zip=await JSZip.loadAsync(out.config3mf);
 assert.equal(out.plate,2); assert.equal(out.sha256,hash(out.config3mf));
 assert.deepEqual(await zip.file('Metadata/plate_2.png').async('nodebuffer'),await source.file('Metadata/plate_2.png').async('nodebuffer'));
 assert.deepEqual(await zip.file('Metadata/plate_2_small.png').async('nodebuffer'),await source.file('Metadata/plate_2_small.png').async('nodebuffer'));
 assert.equal(zip.file('Metadata/plate_1.png'),null); assert.equal(zip.file('Metadata/plate_2.gcode'),null);
 const rel=await zip.file('_rels/.rels').async('string');assert.match(rel,/plate_2\.png/);assert.match(rel,/plate_2_small\.png/);assert.doesNotMatch(rel,/plate_1/);
 const model=await zip.file('3D/3dmodel.model').async('string');assert.doesNotMatch(model,/<object |<item /);
 const config=await zip.file('Metadata/model_settings.config').async('string');assert.match(config,/plater_id" value="2/);assert.doesNotMatch(config,/model_instance|gcode_file|plater_id" value="1/);
 const slice=await zip.file('Metadata/slice_info.config').async('string');assert.match(slice,/key="index" value="2/);assert.doesNotMatch(slice,/key="index" value="1/);
});
test('wrong hash and missing preview refuse without placeholder',async()=>{
 const input=await readFile(fixture);await assert.rejects(buildCloudProjectMedia(input,2,'0'.repeat(64)));
 const zip=await JSZip.loadAsync(input);zip.remove('Metadata/plate_2.png');const changed=await zip.generateAsync({type:'nodebuffer'});await assert.rejects(buildCloudProjectMedia(changed,2,hash(changed)));
});
test('corrupt PNG, XML entity and path aliases fail closed',async()=>{
 const input=await readFile(fixture);
 for(const type of ['png','entity','alias']) {
  const zip=await JSZip.loadAsync(input);
  if(type==='png')zip.file('Metadata/plate_2.png',Buffer.from('not PNG'));
  if(type==='entity')zip.file('Metadata/slice_info.config','<!DOCTYPE config [<!ENTITY x "bad">]><config/>');
  if(type==='alias')zip.file('metadata/PLATE_2.png',Buffer.from('x'));
  const changed=await zip.generateAsync({type:'nodebuffer'});await assert.rejects(buildCloudProjectMedia(changed,2,hash(changed)));
 }
});

test('PNG with a valid header but oversized inflated pixels is rejected',async()=>{
 const {deflateSync}=await import('node:zlib');
 const table=Uint32Array.from({length:256},(_,i)=>{let v=i;for(let n=0;n<8;n++)v=(v>>>1)^((v&1)?0xedb88320:0);return v>>>0;});
 const chunk=(name,data)=>{const type=Buffer.from(name), out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);let c=0xffffffff;for(const b of Buffer.concat([type,data]))c=(c>>>8)^table[(c^b)&255];out.writeUInt32BE((c^0xffffffff)>>>0,8+data.length);return out;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
 const bomb=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(10000))),chunk('IEND',Buffer.alloc(0))]);
 const source=await readFile(fixture),zip=await JSZip.loadAsync(source);zip.file('Metadata/plate_2.png',bomb);
 const changed=await zip.generateAsync({type:'nodebuffer'});await assert.rejects(buildCloudProjectMedia(changed,2,hash(changed)));
});
