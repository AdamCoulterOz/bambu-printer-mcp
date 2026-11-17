import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFilamentAction, classifyFilamentResult, projectAccountResponse } from '../dist/account/filament-actions.js';
import { AccountManager } from '../dist/account/index.js';

const slot = {amsId:0,amsType:3,amsSn:'AMS',slotId:'0',spoolId:42,rfid:'a'.repeat(32),operation:'bind'};
const env = {BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_42',BAMBU_SIGNED_CLOUD_TOKEN:'test-token'};
test('slot mapping needs explicit bind or unbind and rejects duplicates',()=>{
  assert.equal(prepareFilamentAction('sync_mappings',{mappings:[slot]},'PRINTER').body.mappings[0].spoolId,42);
  assert.throws(()=>prepareFilamentAction('sync_mappings',{mappings:[{...slot,operation:'unbind'}]},'PRINTER'));
  assert.throws(()=>prepareFilamentAction('sync_mappings',{mappings:[slot,slot]},'PRINTER'));
  const removed=prepareFilamentAction('sync_mappings',{mappings:[{amsId:0,amsType:3,amsSn:'AMS',slotId:'0',operation:'unbind'}]},'PRINTER');
  assert.equal(removed.body.mappings[0].rfid,null);
});
test('reel updates require explicit numeric identity and partial results remain partial',()=>{
  assert.throws(()=>prepareFilamentAction('update',{filamentName:'PLA'},'PRINTER'));
  assert.throws(()=>prepareFilamentAction('delete',{ids:[1,1]},'PRINTER'));
  const body={mappings:[{amsSn:'AMS',slotId:'0'},{amsSn:'AMS',slotId:'1'}]};
  assert.equal(classifyFilamentResult('sync_mappings',body,{results:[{amsSn:'AMS',slotId:'0',code:0},{amsSn:'AMS',slotId:'1',code:2}]}),'partial');
  assert.equal(classifyFilamentResult('sync_mappings',body,{results:[{amsSn:'AMS',slotId:'0',code:0}]}),'unknown');
  assert.deepEqual(projectAccountResponse({id:1,token:'secret',url:'https://example.com',filamentName:'PLA'}),{id:1,filamentName:'PLA'});
});
test('cloud calls use truthful identity, do not follow redirects, and surface rejected writes', async ()=>{
  const before=globalThis.fetch;
  const calls=[];
  try {
    globalThis.fetch=async (url,opts)=>{calls.push({url,opts});return new Response('{}',{status:403})};
    const a=new AccountManager({sessionDirectory:'/tmp/test-account-action-inaccessible'});
    await assert.rejects(a.filamentAction('delete',{ids:[1]},'PRINTER',env),/HTTP 403/);
    assert.equal(calls.length,1);
    assert.equal(calls[0].opts.redirect,'error');
    assert.equal(calls[0].opts.headers['user-agent'],'bambu-printer-mcp');
  } finally {globalThis.fetch=before;}
});
test('history filters printer, clips fields and coalesces reads',async()=>{
  const before=globalThis.fetch;
  let count=0;
  try {
    globalThis.fetch=async ()=>{count++;return Response.json({total:3,hits:[{deviceId:'ABC',id:1,title:'part',fileUrl:'https://private',status:1},{deviceId:'DEF',id:2,title:'other'}]})};
    const a=new AccountManager({sessionDirectory:'/tmp/test-account-action-inaccessible'});
    const [one,two]=await Promise.all([a.cloudPrintHistory('ABC',env),a.cloudPrintHistory('ABC',env)]);
    assert.equal(count,1);
    assert.deepEqual(one.tasks,[{id:1,title:'part',status:1}]);
    assert.equal(one.complete_account_history,false);
    assert.equal(two.cached,true);
  } finally {globalThis.fetch=before;}
});
test('failed history reads respect the request budget and no stale page leaks across tokens',async()=>{
  const before=globalThis.fetch;
  let count=0;
  try {
    globalThis.fetch=async ()=>{count++;return count===1 ? Response.json({hits:[{deviceId:'ABC',id:1}]}) : new Response('{}',{status:403})};
    const a=new AccountManager({sessionDirectory:'/tmp/test-account-action-inaccessible'});
    await a.cloudPrintHistory('ABC',env);
    const different={...env,BAMBU_SIGNED_CLOUD_TOKEN:'another-token'};
    await assert.rejects(a.cloudPrintHistory('ABC',different),/HTTP 403/);
    await assert.rejects(a.cloudPrintHistory('ABC',different),/read interval/);
    assert.equal(count,2);
  } finally {globalThis.fetch=before;}
});
test('AMS sync omits local expected spool ID from wire and checks returned ID',async()=>{
  const before=globalThis.fetch;
  let body;
  const item={RFID:'1'.repeat(32),amsId:0,amsSn:'AMS',amsType:3,slotId:'0',color:'#000000',colorType:2,colors:['#000000'],filamentId:'GFA00',filamentName:'PLA Basic',filamentType:'PLA',filamentVendor:'Bambu Lab',isSupport:false,netWeight:-5,totalNetWeight:1000,note:'',trayIdName:'A',spoolId:42};
  try {
    globalThis.fetch=async (_url,options)=>{body=JSON.parse(options.body);return Response.json({results:[{amsSn:'AMS',slotId:'0',spoolId:42}]})};
    const a=new AccountManager({sessionDirectory:'/tmp/test-account-action-inaccessible'});
    const result=await a.filamentAction('sync_ams',{items:[item]},'PRINTER',env);
    assert.equal(result.status,'accepted');
    assert.equal(body.items[0].spoolId,undefined);
    assert.equal(body.items[0].netWeight,-5);
  } finally {globalThis.fetch=before;}
});
test('queued write cancelled before its turn never contacts cloud',async()=>{
  const before=globalThis.fetch;
  let release, count=0;
  try {
    globalThis.fetch=async ()=>{count++; await new Promise(resolve=>{release=resolve}); return Response.json({})};
    const a=new AccountManager({sessionDirectory:'/tmp/test-account-action-inaccessible'});
    const first=a.filamentAction('create',{filamentName:'PLA'},'PRINTER',env);
    while (!release) await new Promise(resolve=>setImmediate(resolve));
    const abort=new AbortController();
    const second=a.filamentAction('delete',{ids:[1]},'PRINTER',env,abort.signal);
    abort.abort(); release();
    await first;
    await assert.rejects(second);
    assert.equal(count,1);
  } finally {globalThis.fetch=before;}
});
test('normal MCP entry points route the configured serial to account operations',async t=>{
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const {fileURLToPath}=await import('node:url');
  const entry=fileURLToPath(new URL('../dist/index.js',import.meta.url));
  const moduleUrl=new URL('../dist/account/index.js',import.meta.url).href;
  const preload=`const {AccountManager}=await import(${JSON.stringify(moduleUrl)}); AccountManager.prototype.filamentAction=async (operation,payload,serial)=>({operation,payload,serial,status:'fixture'}); AccountManager.prototype.cloudPrintHistoryPage=async (serial,options)=>({serial,options,tasks:[],next_offset:null}); AccountManager.prototype.cloudPrintHistoryCover=async ()=>({bytes:Buffer.from('fixture'),mimeType:'image/png'});`;
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',`data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,entry],stderr:'pipe',env:{...process.env,MCP_TRANSPORT:'stdio',BAMBU_SERIAL:'TEST_SERIAL',BAMBU_PRINTER_SERIAL:'TEST_SERIAL',BAMBU_MODEL:'',BAMBU_PRINTER_MODEL:''}});
  transport.stderr.on('data',()=>{});
  const client=new Client({name:'account-action-fixture',version:'1'});
  t.after(async()=>{await client.close();await transport.close()});
  await client.connect(transport);
  const write=await client.callTool({name:'account_filament_manager',arguments:{operation:'delete',payload:{ids:[42]}}});
  assert.equal(write.isError,undefined);
  assert.deepEqual(JSON.parse(write.content[0].text),{operation:'delete',payload:{ids:[42]},serial:'TEST_SERIAL',status:'fixture'});
  const history=await client.callTool({name:'account_cloud_print_history',arguments:{offset:50,limit:25}});
  assert.equal(history.isError,undefined);
  assert.equal(JSON.parse(history.content[0].text).serial,'TEST_SERIAL');
  assert.deepEqual(JSON.parse(history.content[0].text).options,{offset:50,limit:25});
  const cover=await client.callTool({name:'account_cloud_print_thumbnail',arguments:{task_id:42}});
  assert.equal(cover.isError,undefined);assert.equal(cover.content.length,2);assert.equal(cover.content[1].type,'image');
  assert.equal(JSON.parse(cover.content[0].text).task_id,42);
  assert.equal(cover.structuredContent,undefined);
  const large=await client.callTool({name:'account_cloud_print_thumbnail',arguments:{task_id:'9007199254740993'}});
  assert.equal(large.isError,undefined);assert.equal(JSON.parse(large.content[0].text).task_id,'9007199254740993');
  assert.equal((await client.callTool({name:'account_cloud_print_thumbnail',arguments:{task_id:42,url:'https://invalid'}})).isError,true);
});
