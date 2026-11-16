import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {ActiveOperation} from '../dist/http-operation.js';
import {requestOwner,withRequestOwner} from '../dist/request-context.js';
const initialize={protocolVersion:'2025-06-18',capabilities:{elicitation:{form:{}}},clientInfo:{name:'fixture',version:'1'}};
const request={jsonrpc:'2.0',id:0,method:'tools/call',params:{name:'confirm',arguments:{}}};
test('detached operation resumes once after human response without rerunning the handler',async()=>{
 let calls=0, input, terminal, resolveInput;const arrived=new Promise(r=>resolveInput=r);let resolveTerminal;const finished=new Promise(r=>resolveTerminal=r);
 const operation=new ActiveOperation({request,initialize,createServer:()=>{const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});server.setRequestHandler(CallToolRequestSchema,(req,extra)=>withRequestOwner(server,extra,async()=>{calls++;const owner=requestOwner();const result=await server.elicitInput({mode:'form',message:'confirm',requestedSchema:{type:'object',properties:{yes:{type:'boolean'}},required:['yes']}},{signal:owner.signal,relatedRequestId:owner.requestId});return {content:[{type:'text',text:String(result.content?.yes)}]};}));return server;},onEvent:event=>{if(event.type==='clientInput'){input=event;resolveInput();}if(event.type==='terminal'){terminal=event;resolveTerminal();}}});
 await operation.start(); await arrived; assert.equal(calls,1);let settled=false;void operation.settled.then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(operation.respond(input.id,{jsonrpc:'2.0',id:'untrusted',result:{action:'accept',content:{yes:true}}}),true);assert.equal(operation.respond(input.id,{jsonrpc:'2.0',id:'again',result:{action:'accept',content:{yes:true}}}),false);await finished;await operation.settled;assert.equal(calls,1);assert.equal(terminal.message.id,0);assert.equal(terminal.message.result.content[0].text,'true');
});
test('deadline revokes authority but retains the operation until a non-cooperative handler settles',async()=>{
 let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);let signal;
 const op=new ActiveOperation({request,initialize,deadlineMs:25,createServer:()=>{const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});s.setRequestHandler(CallToolRequestSchema,(r,e)=>withRequestOwner(s,e,async()=>{signal=requestOwner().signal;started();await gate;return {content:[]};}));return s;},onEvent:()=>{}});
 await op.start();await entered;let settled=false;void op.settled.then(()=>settled=true);await new Promise(r=>setTimeout(r,50));assert.equal(signal.aborted,true);assert.equal(settled,false);release();await op.settled;assert.equal(settled,true);
});
test('stuck operation watchdog forces isolated owner process to exit without backend cleanup', {timeout:8000}, async()=>{
 const {spawn}=await import('node:child_process');
 const script=`import {Server} from '@modelcontextprotocol/sdk/server/index.js';
 import {CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
 import {ActiveOperation} from './dist/http-operation.js';
 import {BambuPrinterMCPServer} from './dist/index.js';
 const owner=Object.create(BambuPrinterMCPServer.prototype);owner.shuttingDown=false;owner.shutdownExitCode=0;owner.server={close:async()=>{}};owner.bambu={disconnectAll:async()=>console.log('UNSAFE_BACKEND_CLEANUP')};
 const op=new ActiveOperation({request:${JSON.stringify(request)},initialize:${JSON.stringify(initialize)},abortGraceMs:20,onUnsettled:()=>{console.error('watchdog');void owner.shutdown(1)},createServer:()=>{const s=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});s.setRequestHandler(CallToolRequestSchema,async()=>new Promise(()=>{}));return s;},onEvent:()=>{}});
 owner.httpRuntime={close:()=>op.settled};setInterval(()=>{},1000);await op.start();await new Promise(r=>setImmediate(r));op.abort();`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,BAMBU_MODEL:''},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,1);assert.match(output,/watchdog/);assert.doesNotMatch(output,/UNSAFE_BACKEND_CLEANUP/);
});
test('terminal settlement closes the transport once and rejects outstanding client input',async()=>{
 let server,closed=0,pending,inputSeen=false;const events=[];
 const op=new ActiveOperation({request,initialize,createServer:()=>{server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});server.onclose=()=>closed++;server.setRequestHandler(CallToolRequestSchema,async(_req,extra)=>{pending=server.elicitInput({mode:'form',message:'fixture',requestedSchema:{type:'object',properties:{yes:{type:'boolean'}}}},{relatedRequestId:extra.requestId,timeout:60_000});void pending.catch(()=>{});return {content:[]};});return server;},onEvent:event=>{events.push(event.type);if(event.type==='clientInput')inputSeen=true;}});
 await op.start();await op.settled;assert.equal(inputSeen,true);assert.deepEqual(events,['clientInput','terminal']);await assert.rejects(pending,/connection closed/i);assert.equal(closed,1);await server.close();assert.equal(closed,1);
});
