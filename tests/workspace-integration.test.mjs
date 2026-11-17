import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Client as ModernClient, StreamableHTTPClientTransport as ModernTransport} from '@modelcontextprotocol/client';
import {BambuPrinterMCPServer} from '../dist/index.js';
import {HttpRequests} from '../dist/http-requests.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function checkMetadata(tools) {
 const tool=tools.find(t=>t.name==='workspace_import_file'); assert.ok(tool);
 assert.deepEqual(tool._meta?.['openai/fileParams'],['file']);
 assert.deepEqual(tool.inputSchema.properties.file.required,['download_url','file_id']);
 assert.ok(tool.inputSchema.properties.file.properties.mime_type);
 assert.ok(tool.inputSchema.properties.file.properties.file_name);
}
async function checkCalls(client) {
 const status=await client.callTool({name:'workspace_status',arguments:{}});
 assert.equal(status.structuredContent.configured,false);
 const failure=await client.callTool({name:'workspace_create',arguments:{}});
 assert.equal(failure.isError,true);assert.equal(failure.structuredContent.code,'FEATURE_UNAVAILABLE');
 assert.equal(typeof failure.structuredContent.next_action,'string');
 const guide=await client.callTool({name:'get_agent_guide',arguments:{topic:'files'}});
 assert.match(guide.structuredContent.text,/workspace_adopt_export/);
 assert.match(guide.structuredContent.text,/successful handoff requires separate verification/);
}
test('stdio discovers file metadata, routes calls and returns typed errors',async t=>{
 const env={...process.env,MCP_TRANSPORT:'stdio',BAMBU_ARTIFACT_DIR:'',BAMBU_MODEL:''};
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/index.js')],env,stderr:'pipe'});transport.stderr.on('data',()=>{});
 const c=new Client({name:'workspace-integration',version:'1'});t.after(()=>c.close());await c.connect(transport);checkMetadata((await c.listTools()).tools);await checkCalls(c);
});
test('legacy and modern HTTP preserve file metadata and dispatch',async t=>{
 const old=process.env.BAMBU_ARTIFACT_DIR;delete process.env.BAMBU_ARTIFACT_DIR;
 const owner=new BambuPrinterMCPServer();
 const runtime=new HttpRequests({host:'127.0.0.1',port:0,path:'/mcp',enableJsonResponse:true,allowedOrigins:new Set(),bearerToken:'test'},()=>owner.createProtocolServer());
 await runtime.listen();const url=new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`);
 t.after(async()=>{await runtime.close();if(old===undefined)delete process.env.BAMBU_ARTIFACT_DIR;else process.env.BAMBU_ARTIFACT_DIR=old;});
 const legacy=new Client({name:'legacy-workspace',version:'1'});await legacy.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:'Bearer test'}}}));
 t.after(()=>legacy.close());checkMetadata((await legacy.listTools()).tools);await checkCalls(legacy);
 const modern=new ModernClient({name:'modern-workspace',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await modern.connect(new ModernTransport(url,{requestInit:{headers:{authorization:'Bearer test'}}}));
 t.after(()=>modern.close());checkMetadata((await modern.listTools()).tools);await checkCalls(modern);
});
