import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema,ElicitRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {HttpRequests} from '../dist/http-requests.js';
import {lazyJsonSchemaValidator} from '../dist/lazy-json-schema-validator.js';
import {requestOwner,withRequestOwner} from '../dist/request-context.js';

test('metadata needs no schema validator; concurrent inputs validate independently',async()=>{
 let validators=0,effects=0;
 const validator={getValidator(schema){validators++;return lazyJsonSchemaValidator.getValidator(schema);}};
 const runtime=new HttpRequests({host:'127.0.0.1',port:0,path:'/mcp',enableJsonResponse:true,allowedOrigins:new Set()},()=>{
  const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}},jsonSchemaValidator:validator});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'confirm',inputSchema:{type:'object'}}]}));
  server.setRequestHandler(CallToolRequestSchema,(req,extra)=>withRequestOwner(server,extra,async()=>{const {signal,requestId}=requestOwner();const result=await server.elicitInput({mode:'form',message:'Confirm',requestedSchema:{type:'object',properties:{confirmed:{type:'boolean'}},required:['confirmed']}},{signal,relatedRequestId:requestId});if(result.action==='accept' && result.content?.confirmed===true) effects++;return {content:[{type:'text',text:'done'}]};}));return server;
 });
 await runtime.listen();const url=new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`);let releaseA,releaseB;const aGate=new Promise(r=>releaseA=r),bGate=new Promise(r=>releaseB=r);let arrived=0;const clients=[];
 async function connect(handler){const c=new Client({name:'fixture',version:'1'},{capabilities:{elicitation:{form:{}}}});c.setRequestHandler(ElicitRequestSchema,handler);await c.connect(new StreamableHTTPClientTransport(url));clients.push(c);return c;}
 try {const a=await connect(async()=>{arrived++;await aGate;return {action:'accept',content:{confirmed:true}};});const b=await connect(async()=>{arrived++;await bGate;return {action:'accept',content:{confirmed:'not-a-boolean'}};});await Promise.all([a.listTools(),b.listTools()]);assert.equal(validators,0);
 const first=a.callTool({name:'confirm'}),second=b.callTool({name:'confirm'});for(let i=0;i<200&&arrived<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(arrived,2);releaseB();await assert.rejects(second,/validat|schema/i);assert.equal(effects,0);releaseA();assert.equal((await first).content[0].text,'done');assert.equal(effects,1);assert.equal(validators,2);
 }finally{releaseA();releaseB();await Promise.allSettled(clients.map(c=>c.close()));await runtime.close();}
});
