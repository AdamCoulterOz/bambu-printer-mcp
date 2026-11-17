import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {inspectRemoteArchive} from '../dist/tutk-direct/archive.js';
async function archive(name,data=Buffer.from('preview')) {const zip=new JSZip();zip.file(name,data);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',platform:'UNIX'});}
test('bounded archive lists and extracts exact member',async()=>{
 const b=await archive('Metadata/plate_1.png');const list=await inspectRemoteArchive(b);
 assert.deepEqual(list.entries,['Metadata/plate_1.png']);assert.equal((await inspectRemoteArchive(b,'Metadata/plate_1.png')).bytes.toString(),'preview');
 await assert.rejects(inspectRemoteArchive(b,'missing'));
});
test('archive rejects unsafe names, symlinks and inflated bombs',async()=>{
 await assert.rejects(inspectRemoteArchive(await archive('../outside')));await assert.rejects(inspectRemoteArchive(await archive('C:/outside')));await assert.rejects(inspectRemoteArchive(await archive('bad\x7fname')));
 const zip=new JSZip();zip.file('link','target',{unixPermissions:0o120777});await assert.rejects(inspectRemoteArchive(await zip.generateAsync({type:'nodebuffer',platform:'UNIX'})));
 await assert.rejects(inspectRemoteArchive(await archive('huge',Buffer.alloc(8*1024*1024+1))));
});
