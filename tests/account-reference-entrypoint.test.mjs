import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

for(const scenario of ['success','status_error','nozzle_mismatch','material_change','changed_ref','account_flip','declined','unknown','cancel','stale_handoff','mapping_missing','mapping_success','mapping_partial','mapping_duplicate','mapping_noncanonical','mapping_missing_material','mapping_changed_slot','occupancy_state_zero','occupancy_zero_nomask','occupancy_missing']) test(`normal MCP reference route ${scenario}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bambu-reference-entry-'));const log=join(dir,'events');
 const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
 const loader=fileURLToPath(new URL('./account-reference-loader.mjs',import.meta.url));
 const preload=fileURLToPath(new URL('./support/account-reference-preload.mjs',import.meta.url));
 const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-loader',loader,'--import',preload,entry],stderr:'pipe',env:{...process.env,MCP_TRANSPORT:'stdio',REFERENCE_TEST_LOG:log,REFERENCE_TEST_SCENARIO:scenario,BAMBU_RESUME_STATE_DIR:dir,BAMBU_SIGNED_CONTROLS:'true',BAMBU_CLOUD_PRINT_ENABLED:'true',BAMBU_SIGNING_DIR:dir,BAMBU_SIGNING_DEVICE_CA_FILE:join(dir,'ca.pem'),BAMBU_SIGNING_STATE_DIR:dir,BAMBU_SIGNED_WRITE_TRANSPORT:'local',BAMBU_PRINTER_HOST:'127.0.0.1',BAMBU_PRINTER_SERIAL:'20PTEST',BAMBU_PRINTER_ACCESS_TOKEN:'dummy',BAMBU_HANDY_OS_VERSION:'fixture'}});
 transport.stderr.on('data',()=>{});const client=new Client({name:'reference-fixture',version:'1'});
 try {
  await client.connect(transport);
  let result;
  let current_mapping=[{filamentId:2,ams:1,amsId:0,slotId:1},{filamentId:3,ams:128,amsId:128,slotId:0}];
  if(scenario==='mapping_partial')current_mapping=current_mapping.slice(0,1);
  if(scenario==='mapping_duplicate')current_mapping[1]={...current_mapping[1],filamentId:2};
  if(scenario==='mapping_noncanonical')current_mapping[0]={...current_mapping[0],slotId:2};
  const arguments_={task_id:'42',confirm_original_job_reference:true,...(scenario.startsWith('mapping_')&&scenario!=='mapping_missing'?{current_mapping}:{})};
  if(scenario==='cancel') {
   const controller=new AbortController();const call=client.callTool({name:'account_reprint_cloud_task',arguments:arguments_},undefined,{signal:controller.signal});
   for(let i=0;i<100;i++){try{if((await readFile(log,'utf8')).includes('status_waiting'))break;}catch{}await new Promise(r=>setTimeout(r,5));}
   controller.abort();await assert.rejects(call);await new Promise(r=>setTimeout(r,250));
  } else result=await client.callTool({name:'account_reprint_cloud_task',arguments:arguments_});
  let events=[];try{events=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
  const posts=events.filter(e=>e.kind==='post');
  if(scenario==='cancel') {assert.equal(posts.length,0);assert.ok(events.some(e=>e.kind==='status_waiting'));}
  else if(scenario==='success'||scenario==='mapping_success') {
   assert.equal(result.isError,undefined);assert.equal(posts.length,1);assert.equal(result.structuredContent.verification,'provider_completed_job_reference');assert.equal(result.structuredContent.newTaskId,'99');
   assert.equal(result.structuredContent.mappingSource,scenario==='mapping_success'?'explicit_current_selection':'historical');
   assert.deepEqual(Object.keys(posts[0].payload).sort(),['amsDetailMapping','amsMapping','amsMapping2','bedType','deviceId','instanceId','isPublicProfile','mode','modelId','plateIndex','profileId','useAms'].sort());
   const confirmation=events.find(e=>e.kind==='confirmation');assert.equal(confirmation.physical,true);assert.match(confirmation.message,/bytes and temperatures have not been inspected/);
   assert.match(confirmation.message,/filament 2, nozzle 1, tray 1/);
  } else if(scenario==='unknown') {
   assert.equal(result.isError,true);assert.equal(posts.length,1);assert.equal(result.structuredContent.printOutcome,'unknown');assert.equal(result.structuredContent.reference_receipt.sourceTaskId,'42');
   const retry=await client.callTool({name:'account_reprint_cloud_task',arguments:arguments_});assert.equal(retry.isError,true);assert.match(JSON.stringify(retry),/pending or uncertain/);
   const after=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(after.filter(e=>e.kind==='post').length,1);
   const hold=await client.callTool({name:'account_reprint_hold',arguments:{action:'status'}});assert.equal(hold.structuredContent.state,'unknown');
   const refused=await client.callTool({name:'account_reprint_hold',arguments:{action:'recover'}});assert.equal(refused.isError,true);
   const cleared=await client.callTool({name:'account_reprint_hold',arguments:{action:'recover',acknowledge_review:true}});assert.equal(cleared.structuredContent.state,'cleared');
   const reviewed=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.ok(reviewed.some(e=>e.kind==='confirmation'&&e.physical&&e.message.includes('account history')));
  }
  else {assert.equal(result.isError,true);assert.equal(posts.length,0);if(scenario==='mapping_missing')assert.match(JSON.stringify(result),/requires_current_mapping/);}
 } finally {await client.close().catch(()=>{});await transport.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
