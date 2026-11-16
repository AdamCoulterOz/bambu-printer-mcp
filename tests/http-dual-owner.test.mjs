import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client as LegacyClient} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport as LegacyTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Client as ModernClient,StreamableHTTPClientTransport as ModernTransport} from '@modelcontextprotocol/client';
test('actual owner serves the same six safe surfaces to both protocol eras',async()=>{
 const before={...process.env};const cwd=process.cwd();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-dual-owner-'));process.chdir(dir);
 for(const key of Object.keys(process.env)) if(/^(BAMBU_|MCP_HTTP_|BLENDER_|FUSION_|CAD_|PRINTER_|TEMP_DIR$)/.test(key)) delete process.env[key];
 Object.assign(process.env,{MCP_TRANSPORT:'streamable-http',MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_PORT:'0',BAMBU_MODEL:'',BAMBU_PRINTER_HOST:'127.0.0.1',BAMBU_PRINTER_SERIAL:'fixture',BAMBU_PRINTER_ACCESS_TOKEN:'fixture',CAD_ENABLED:'0',TEMP_DIR:dir});
 let owner;let a,b;
 try {const {BambuPrinterMCPServer}=await import('../dist/index.js');owner=new BambuPrinterMCPServer();await owner.startHttp();const backend=owner.bambu;const url=new URL(`http://127.0.0.1:${owner.httpRuntime.httpServer.address().port}/mcp`);
 a=new LegacyClient({name:'legacy-fixture',version:'1'});b=new ModernClient({name:'modern-fixture',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await Promise.all([a.connect(new LegacyTransport(url)),b.connect(new ModernTransport(url))]);
 const toolResults=await Promise.all([a.listTools(),b.listTools()]);assert.deepEqual(toolResults[0].tools,toolResults[1].tools);
 const resourceResults=await Promise.all([a.listResources(),b.listResources()]);assert.deepEqual(resourceResults[0].resources,resourceResults[1].resources);
 const promptResults=await Promise.all([a.listPrompts(),b.listPrompts()]);assert.deepEqual(promptResults[0].prompts,promptResults[1].prompts);
 const uri=resourceResults[0].resources.find(r=>r.uri.startsWith('bambu://workflow/')).uri;assert.deepEqual((await a.readResource({uri})).contents,(await b.readResource({uri})).contents);
 const name=promptResults[0].prompts[0].name;const legacyPrompt=await a.getPrompt({name}),modernPrompt=await b.getPrompt({name});assert.equal(legacyPrompt.description,modernPrompt.description);assert.deepEqual(legacyPrompt.messages,modernPrompt.messages);
 const guide=await Promise.all([a.callTool({name:'get_agent_guide',arguments:{}}),b.callTool({name:'get_agent_guide',arguments:{}})]);assert.deepEqual(guide[0].content,guide[1].content);assert.deepEqual(guide[0].structuredContent,guide[1].structuredContent);const readiness=await Promise.all([a.callTool({name:'get_agent_readiness',arguments:{}}),b.callTool({name:'get_agent_readiness',arguments:{}})]);assert.deepEqual(readiness[0].structuredContent,readiness[1].structuredContent);assert.equal(owner.bambu,backend);assert.equal(owner.httpRuntime.stats().admittedOperations,0);
 }finally{await Promise.allSettled([a?.close(),b?.close()]);await owner?.httpRuntime.close();await owner?.server.close();process.chdir(cwd);for(const key of Object.keys(process.env)) if(!(key in before)) delete process.env[key];Object.assign(process.env,before);fs.rmSync(dir,{recursive:true,force:true});}
});
