import test from 'node:test';
import assert from 'node:assert/strict';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createModernHttpAdapter} from '../dist/http-modern.js';
import {withRequestOwner} from '../dist/request-context.js';
const schema={type:'object',properties:{confirmed:{type:'boolean'}},required:['confirmed']};
function fixture(options={}) {
 let invoked=0, closed=0, reserved=0, released=0;
 const adapter=createModernHttpAdapter({...options,reserveOperation:()=>{reserved++;return()=>released++;},createProtocolServer:()=>{
  const s=new Server({name:'fake',version:'1'},{capabilities:{tools:{},resources:{},prompts:{}}});
  s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'check',description:'test',inputSchema:{type:'object',properties:{rounds:{type:'number'}}}}]}));
  s.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'test://one',name:'One'}]}));
  s.setRequestHandler(ReadResourceRequestSchema,async()=>({contents:[{uri:'test://one',text:'resource'}]}));
  s.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:[{name:'prompt'}]}));
  s.setRequestHandler(GetPromptRequestSchema,async()=>({messages:[{role:'user',content:{type:'text',text:'prompt'}}]}));
  s.setRequestHandler(CallToolRequestSchema,(req,extra)=>withRequestOwner(s,extra,async()=>{invoked++;if(req.params.arguments?.progress) await extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta?.progressToken,progress:1,total:2}});let approvals=[];const ask=()=>s.elicitInput({mode:'form',message:'Confirm',requestedSchema:schema},{signal:extra.signal,relatedRequestId:extra.requestId}); if(req.params.arguments?.parallel) {const results=await Promise.all([ask(),ask()]); approvals=results.map(a=>a.action==='accept' && a.content?.confirmed===true);} else for(let i=0;i<(req.params.arguments?.rounds??0);i++) {let a=await ask();approvals.push(a.action==='accept' && a.content?.confirmed===true);}return {content:[{type:'text',text:JSON.stringify(approvals)}]};}));
  const close=s.close.bind(s);s.close=async()=>{closed++;return close();};return s;
 }});
 return {adapter,counts:()=>({invoked,closed,reserved,released})};
}
async function client(adapter,mode='auto',handler=async()=>({action:'accept',content:{confirmed:true}}),fetchWrap) {
 const c=new Client({name:'fixture',version:'1'},{capabilities:{elicitation:{form:{}}},versionNegotiation:{mode}});c.setRequestHandler('elicitation/create',handler);
 const fetcher=async(url,init)=>{const request=new Request(url,init);return fetchWrap?fetchWrap(request,adapter):adapter.fetch(request);};
 await c.connect(new StreamableHTTPClientTransport(new URL('http://fixture/mcp'),{fetch:fetcher})); return c;
}
const drain=()=>new Promise(r=>setImmediate(r));
test('auto and pinned modern clients preserve all six methods and multi-round confirmations',async()=>{
 const {adapter,counts}=fixture();
 for(const mode of ['auto',{pin:'2026-07-28'}]) {const c=await client(adapter,mode);assert.equal((await c.listTools()).tools[0].inputSchema.properties.rounds.type,'number');assert.equal((await c.listResources()).resources[0].uri,'test://one');assert.equal((await c.readResource({uri:'test://one'})).contents[0].text,'resource');assert.equal((await c.listPrompts()).prompts[0].name,'prompt');assert.equal((await c.getPrompt({name:'prompt'})).messages[0].content.text,'prompt');assert.equal((await c.callTool({name:'check',arguments:{rounds:2}})).content[0].text,'[true,true]');await c.close();}
 await drain();assert.equal(counts().invoked,2);assert.equal(adapter.stats().activeOperations,0);assert.equal(counts().reserved,counts().released);await adapter.close();
});
test('decline is passed to the same operation without approval',async()=>{const {adapter,counts}=fixture();const c=await client(adapter,'auto',async()=>({action:'decline'}));assert.equal((await c.callTool({name:'check',arguments:{rounds:1}})).content[0].text,'[false]');assert.equal(counts().invoked,1);await c.close();await adapter.close();});
test('a hundred sequential calls leave no operations or reservations',async()=>{const {adapter,counts}=fixture();const c=await client(adapter);for(let i=0;i<100;i++) await c.callTool({name:'check',arguments:{rounds:0}});await drain();assert.equal(adapter.stats().activeOperations,0);assert.equal(counts().reserved,counts().released);await c.close();await adapter.close();});
test('tampered, foreign, changed arguments, and replayed state cannot dispatch again',async()=>{
 const {adapter,counts}=fixture();let first;let retry;
 const c=await client(adapter,'auto',async()=>({action:'accept',content:{confirmed:true}}),async(request,a)=>{
  const body=await request.clone().json(); const response=await a.fetch(request);
  if(body.method==='tools/call' && !body.params.requestState) {const r=await response.clone().json(); if(r.result?.requestState) first=r.result.requestState;}
  if(body.params?.requestState) retry=body;
  return response;
 });
 await c.callTool({name:'check',arguments:{rounds:1}});assert(first);assert(retry);
 async function check(mutator,authInfo) {const body=structuredClone(retry);body.id=12345;mutator(body);const r=await adapter.fetch(new Request('http://fixture/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(body)}),{authInfo});assert((await r.json()).error);}
 await check(b=>{b.params.requestState=first+'x'});
 await check(b=>{b.params.arguments.rounds=3});
 await check(()=>{}, {clientId:'foreign',token:'unused',scopes:[]});
 await check(()=>{});
 assert.equal(counts().invoked,1);await c.close();await adapter.close();
});
test('an invalid accepted answer cannot resume and no dispatch is repeated',async()=>{
 const {adapter,counts}=fixture();
 const c=await client(adapter,'auto',async()=>({action:'accept',content:{confirmed:true}}),async(request,a)=>{
  const body=await request.clone().json();
  if(body.params?.inputResponses) {Object.values(body.params.inputResponses)[0].content.confirmed='yes';return a.fetch(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body),signal:request.signal}));}
  return a.fetch(request);
 });
 await assert.rejects(c.callTool({name:'check',arguments:{rounds:1}}));assert.equal(counts().invoked,1);await c.close();
 // Expire the abandoned operation rather than simulating approval.
 await adapter.close();
});

test('parallel prompts resume the same operation',async()=>{const {adapter,counts}=fixture();const c=await client(adapter);assert.equal((await c.callTool({name:'check',arguments:{parallel:true}})).content[0].text,'[true,true]');assert.equal(counts().invoked,1);await c.close();await adapter.close();});
test('abandoned confirmation expires and releases the operation',async()=>{const {adapter,counts}=fixture({pendingTimeoutMs:40});let resume;let prompted;const entered=new Promise(r=>prompted=r);const c=await client(adapter,'auto',()=>{prompted();return new Promise(r=>resume=r);});const call=c.callTool({name:'check',arguments:{rounds:1}});await entered;await new Promise(r=>setTimeout(r,100));assert.equal(adapter.stats().activeOperations,0);assert.equal(counts().reserved,counts().released);resume({action:'accept',content:{confirmed:true}});await assert.rejects(call);assert.equal(counts().invoked,1);await c.close();await adapter.close();});
test('cancellation during virtual initialization prevents handler dispatch and releases its reservation',async()=>{
 let releaseConnect,enteredConnect,invoked=0,reserved=0,released=0;
 const gate=new Promise(r=>releaseConnect=r);const entered=new Promise(r=>enteredConnect=r);
 const adapter=createModernHttpAdapter({reserveOperation:()=>{reserved++;return()=>released++;},createProtocolServer:()=>{
  const s=new Server({name:'fake',version:'1'},{capabilities:{tools:{}}});const connect=s.connect.bind(s);s.connect=async transport=>{enteredConnect();await gate;return connect(transport);};s.setRequestHandler(CallToolRequestSchema,async()=>{invoked++;return {content:[]};});return s;
 }});
 const c=await client(adapter,{pin:'2026-07-28'});const controller=new AbortController();const call=c.callTool({name:'check',arguments:{}},{signal:controller.signal});await entered;controller.abort();await assert.rejects(call);releaseConnect();await new Promise(r=>setTimeout(r,20));assert.equal(invoked,0);assert.equal(adapter.stats().activeOperations,0);assert.equal(reserved,released);await c.close();await adapter.close();
});

test('progress notification streams on its owning modern request',async()=>{const {adapter}=fixture();const c=await client(adapter);const seen=[];await c.callTool({name:'check',arguments:{progress:true}},{onprogress:p=>seen.push(p.progress)});assert.deepEqual(seen,[1]);await c.close();await adapter.close();});
test('live pending continuation rejects changed claims and invalid inputs without consuming it',async()=>{
 const {adapter,counts}=fixture();let original,required,ready;const seen=new Promise(r=>ready=r);let resume;let prompted;const entered=new Promise(r=>prompted=r);
 const c=await client(adapter,'auto',()=>{prompted();return new Promise(r=>resume=r);},async(request,a)=>{const body=await request.clone().json();const response=await a.fetch(request);if(body.method==='tools/call'&&!body.params.requestState){const result=(await response.clone().json()).result;if(result?.requestState){original=body;required=result;ready();}}return response;});
 const call=c.callTool({name:'check',arguments:{rounds:1}});await seen;await entered;const key=Object.keys(required.inputRequests)[0];
 async function bad(change,authInfo){const body=structuredClone(original);body.id=897;body.params.requestState=required.requestState;body.params.inputResponses={[key]:{action:'accept',content:{confirmed:true}}};change(body);const response=await adapter.fetch(new Request('http://fixture/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(body)}),{authInfo});assert((await response.json()).error);assert.equal(adapter.stats().pendingContinuations,1);assert.equal(counts().invoked,1);}
 await bad(b=>{b.params.arguments.rounds=2});
 await bad(b=>{b.params._meta['io.modelcontextprotocol/clientCapabilities']={};});
 await bad(()=>{}, {clientId:'other',token:'not-used',scopes:[]});
 await bad(b=>{b.params.requestState+='x';});
 await bad(b=>{delete b.params.requestState;});
 await bad(b=>{b.params.inputResponses[key].content.confirmed='yes';});
 await bad(b=>{delete b.params.inputResponses[key].content.confirmed;});
 await bad(b=>{b.params.inputResponses[key].content.confirmed=null;});
 resume({action:'accept',content:{confirmed:true}});assert.equal((await call).content[0].text,'[true]');assert.equal(counts().invoked,1);await c.close();await adapter.close();
});
test('omitted client info and empty capabilities support discovery but do not grant elicitation',async()=>{
 const {adapter,counts}=fixture();let prompts=0;
 const c=await client(adapter,{pin:'2026-07-28'},async()=>{prompts++;return {action:'accept',content:{confirmed:true}}},async(request,a)=>{
  const body=await request.clone().json();if(body.method!=='server/discover' && body.params?._meta){delete body.params._meta['io.modelcontextprotocol/clientInfo'];body.params._meta['io.modelcontextprotocol/clientCapabilities']={};}
  return a.fetch(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body),signal:request.signal}));
 });
 assert.equal((await c.listTools()).tools[0].name,'check');
 await assert.rejects(c.callTool({name:'check',arguments:{rounds:1}}));assert.equal(prompts,0);assert.equal(counts().invoked,1);await c.close();await adapter.close();
});
test('SDK rejects missing modern capabilities before invoking the backend',async()=>{
 const {adapter,counts}=fixture();const c=await client(adapter,{pin:'2026-07-28'},undefined,async(request,a)=>{const body=await request.clone().json();if(body.method!=='server/discover'&&body.params?._meta)delete body.params._meta['io.modelcontextprotocol/clientCapabilities'];return a.fetch(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body),signal:request.signal}));});
 await assert.rejects(c.listTools(),/clientCapabilities: missing/);assert.equal(counts().reserved,0);await c.close();await adapter.close();
});
