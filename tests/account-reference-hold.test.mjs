import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {withPrintStartGuard,markReferenceUnknown,bindReferenceTask,inspectReferenceHold,observeReferenceHold,clearReferenceHold} from '../dist/safety/reference-hold.js';
import {withPrinterOperation} from '../dist/safety/artifact.js';
import {BambuImplementation} from '../dist/printers/bambu.js';
import {withPrivateLock} from '../dist/safety/private-lock.js';

async function fixture(fn) {
 const dir=await mkdtemp(join(tmpdir(),'reference-hold-')),old=process.env.BAMBU_RESUME_STATE_DIR;process.env.BAMBU_RESUME_STATE_DIR=dir;
 try {await fn(dir);} finally {if(old===undefined)delete process.env.BAMBU_RESUME_STATE_DIR;else process.env.BAMBU_RESUME_STATE_DIR=old;await rm(dir,{recursive:true,force:true});}
}
const status=(serial,state,task)=>({connected:true,serial,raw:{gcode_state:state,task_id:task},observation:{source:'mqtt',requestedAt:Date.now(),receivedAt:Date.now()}});

test('unknown hold survives a process restart and blocks the same serial irrespective of case',async()=>fixture(async dir=>{
 await withPrintStartGuard('20PTEST',async()=>{markReferenceUnknown('20PTEST');});
 await assert.rejects(withPrintStartGuard('20ptest',async()=>{}),/pending or uncertain/);
 await assert.rejects(withPrinterOperation('alternate-host','20PTEST',async()=>{},true),/pending or uncertain/);
 let controlRan=false;await withPrinterOperation('alternate-host','20PTEST',async()=>{controlRan=true;});assert.equal(controlRan,true);
 assert.equal(await observeReferenceHold('20PTEST',status('20PTEST','IDLE','0')),'unknown');
 const moduleUrl=new URL('../dist/safety/reference-hold.js',import.meta.url).href;
 const output=execFileSync(process.execPath,['--input-type=module','-e',`import {inspectReferenceHold} from ${JSON.stringify(moduleUrl)};console.log((await inspectReferenceHold('20PTEST')).state);`],{env:{...process.env,BAMBU_RESUME_STATE_DIR:dir},encoding:'utf8'});
 assert.equal(output.trim(),'unknown');
 const hold=await inspectReferenceHold('20PTEST');await clearReferenceHold('20PTEST',hold.nonce,async remove=>remove());
 assert.equal((await inspectReferenceHold('20PTEST')).state,'none');
}));

test('known task hold remains until explicit recovery without a collector connection epoch',async()=>fixture(async()=>{
 await withPrintStartGuard('20PTEST',async()=>{markReferenceUnknown('20PTEST');bindReferenceTask('20PTEST','99');});
 await new Promise(r=>setTimeout(r,5));
 assert.equal(await observeReferenceHold('20PTEST',status('20PTEST','FINISH','99')),'pending');
 assert.equal(await observeReferenceHold('20PTEST',status('20PTEST','RUNNING','98')),'pending');
 assert.equal(await observeReferenceHold('20PTEST',status('20PTEST','RUNNING','99')),'pending');
 assert.equal(await observeReferenceHold('20PTEST',status('20PTEST','FINISH','99')),'pending');
 await assert.rejects(withPrintStartGuard('20PTEST',async()=>{}),/pending or uncertain/);
 const hold=await inspectReferenceHold('20PTEST');await clearReferenceHold('20PTEST',hold.nonce,async remove=>remove());
}));

test('stale report cannot clear a known hold and an old confirmation cannot clear a replacement',async()=>fixture(async()=>{
 await withPrintStartGuard('20PTEST',async()=>{markReferenceUnknown('20PTEST');bindReferenceTask('20PTEST','99');});
 const stale=status('20PTEST','RUNNING','99');stale.observation.requestedAt-=60000;
 await assert.rejects(observeReferenceHold('20PTEST',stale),/fresh/);
 const hold=await inspectReferenceHold('20PTEST');await assert.rejects(clearReferenceHold('20PTEST','00000000-0000-0000-0000-000000000000',async remove=>remove()),/changed/);
 await clearReferenceHold('20PTEST',hold.nonce,async remove=>remove());
}));

test('a durable hold blocks direct file, upload-and-print, and remote-start paths',async()=>fixture(async()=>{
 const serial='PRINTER123';await withPrintStartGuard(serial,async()=>{markReferenceUnknown(serial);});
 const printer=new BambuImplementation();
 await assert.rejects(printer.print3mf('host',serial,'dummy',{filePath:'/no-file.3mf',bambuModel:'p1s'}),/pending or uncertain/);
 await assert.rejects(printer.uploadFile('host',serial,'dummy','/no-file.gcode','job.gcode',true,'p1s'),/pending or uncertain/);
 await assert.rejects(printer.startJob('host',serial,'dummy','job.gcode','p1s'),/pending or uncertain/);
}));

test('recovery revalidates under the hold lock and cancellation while waiting never clears',async()=>fixture(async dir=>{
 const serial='20PTEST';await withPrintStartGuard(serial,async()=>{markReferenceUnknown(serial);});
 const hold=await inspectReferenceHold(serial),path=join(dir,'reference-holds',createHash('sha256').update(serial).digest('hex'));
 let release,ready;const entered=new Promise(r=>{ready=r;}),blocked=new Promise(r=>{release=r;});
 const locked=withPrivateLock(path,async()=>{ready();await blocked;});await entered;
 const controller=new AbortController();let invoked=false;
 const waiting=clearReferenceHold(serial,hold.nonce,async remove=>{invoked=true;remove();},controller.signal);
 await new Promise(r=>setTimeout(r,30));controller.abort();await assert.rejects(waiting);release();await locked;
 assert.equal(invoked,false);assert.equal((await inspectReferenceHold(serial)).state,'unknown');
 await assert.rejects(clearReferenceHold(serial,hold.nonce,async()=>{throw Error('stale authority or report');}),/stale/);
 assert.equal((await inspectReferenceHold(serial)).state,'unknown');
 await clearReferenceHold(serial,hold.nonce,async remove=>remove());
}));
