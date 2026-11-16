import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-recovery-'));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'fixture-secret', {mode: 0o600});
  let generation = 0, inits = 0, toolMode = '', hold, serverVersion = '1', heldClosed = false;
  const posts = [];
  const web = http.createServer(async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') return res.writeHead(405).end();
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks)); posts.push(msg);
    if (msg.method === 'initialize') {
      inits++; res.writeHead(200, {'content-type': 'application/json', 'mcp-session-id': `ticket-${generation}`});
      return res.end(JSON.stringify({jsonrpc:'2.0', id:msg.id, result:{protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:serverVersion}}}));
    }
    if (req.headers['mcp-session-id'] !== `ticket-${generation}`) return res.writeHead(404).end('private-body');
    if (msg.method === 'tools/call' && ['401','403','503'].includes(toolMode)) return res.writeHead(Number(toolMode), {'retry-after':'30'}).end('fixture-secret private-body');
    if (msg.method === 'tools/call' && toolMode === 'hold') { res.once('close', () => { heldClosed = true; }); hold = () => res.end(JSON.stringify({jsonrpc:'2.0', id:msg.id, result:{content:[]}})); res.writeHead(200, {'content-type':'application/json'}); return; }
    if (msg.method === 'tools/call' && toolMode === 'drop') return req.socket.destroy();
    if (!('id' in msg)) return res.writeHead(202).end();
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0', id:msg.id, result:msg.method === 'tools/list' ? {tools:[]} : {content:[]}}));
  });
  await new Promise(resolve => web.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${web.address().port}/mcp`;
  const transport = new StdioClientTransport({command:process.execPath,args:['dist/http-client-bridge.js'],env:{...process.env,BAMBU_MCP_HTTP_URL:url,BAMBU_MCP_HTTP_TOKEN_FILE:tokenFile},stderr:'pipe'});
  const client = new Client({name:'recovery-client',version:'1'}, {capabilities:{elicitation:{form:{}}}});
  await client.connect(transport);
  t.after(async () => { if (hold) hold(); await client.close().catch(()=>{}); web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); await rm(dir,{recursive:true,force:true}); });
  return {client,transport,url,tokenFile,posts,restart:()=>generation++, count:()=>inits, mode:x=>toolMode=x, changeContract:()=>serverVersion='2', heldClosed:()=>heldClosed, release:()=>{hold?.(); hold=undefined;}};
}

test('expired tickets recover concurrent discovery once while preserving initialization', async t => {
  const f = await fixture(t); f.restart();
  const results = await Promise.all([f.client.listTools(), f.client.listTools()]);
  assert.deepEqual(results.map(r=>r.tools), [[],[]]); assert.equal(f.count(),2);
  const init = f.posts.filter(p=>p.method === 'initialize'); assert.deepEqual(init[1].params,init[0].params);
  assert.equal(f.posts.filter(p=>p.method === 'tools/list').length,4);
});
test('expired and disconnected tool calls never replay', async t => {
  const f = await fixture(t); f.restart();
  await assert.rejects(f.client.callTool({name:'fixture'}), /not replayed/);
  assert.equal(f.posts.filter(p=>p.method === 'tools/call').length,1);
  await f.client.listTools(); f.mode('drop');
  await assert.rejects(f.client.callTool({name:'fixture'}));
  assert.equal(f.posts.filter(p=>p.method === 'tools/call').length,2);
});
test('recovery does not disturb an unrelated in-flight tool call', async t => {
  const f = await fixture(t); f.mode('hold');
  const call = f.client.callTool({name:'fixture'});
  while (!f.posts.some(p=>p.method === 'tools/call')) await new Promise(r=>setTimeout(r,5));
  f.restart(); await assert.rejects(f.client.listTools(), /another request was in flight/);
  assert.equal(f.count(),1); f.release(); await call;
});

test('recovery refuses a changed server contract without forwarding hidden initialization', async t => {
  const f = await fixture(t); f.restart(); f.changeContract();
  await assert.rejects(f.client.listTools(), /contract changed/);
  assert.equal(f.count(),2); assert.equal(f.posts.filter(p=>p.method === 'tools/list').length,1);
});
for (const status of ['401','403','503']) test(`HTTP ${status} is redacted and never retried`, async t => {
  const f = await fixture(t); f.mode(status);
  await assert.rejects(f.client.callTool({name:'fixture'}), error => {
    assert.match(error.message, new RegExp(status));
    assert.doesNotMatch(error.message, /fixture-secret|private-body/);
    if (status === '503') assert.match(error.message, /retry-after indicated/);
    return true;
  });
  assert.equal(f.posts.filter(p=>p.method === 'tools/call').length,1);
});

for (const signal of ['SIGTERM','SIGINT']) test(`${signal} closes the relay without stopping the backend`, async t => {
  const f = await fixture(t); const pid = f.transport.pid;
  const closed = new Promise(resolve => { const prior = f.transport.onclose; f.transport.onclose = () => { prior?.(); resolve(); }; });
  process.kill(pid, signal);
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('relay did not close')), 2500))]);
  // The listener remains available to a separate connection after relay shutdown.
  assert.equal((await fetch(f.url)).status,405);
});

for (const params of [{protocolVersion:'2025-03-26'}, {protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'x'.repeat(65536),version:'1'}}]) {
  test('malformed or oversized initialization is rejected locally', async t => {
    const f = await fixture(t);
    const child = spawn(process.execPath, ['dist/http-client-bridge.js'], {env:{...process.env,BAMBU_MCP_HTTP_URL:f.url,BAMBU_MCP_HTTP_TOKEN_FILE:f.tokenFile},stdio:['pipe','pipe','pipe']});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params})+'\n');
    const [data] = await once(child.stdout,'data');
    const reply = JSON.parse(data.toString().trim());
    assert.equal(reply.id,0); assert.match(reply.error.message,/Invalid or oversized/);
    assert.equal(f.count(),1); child.stdin.end(); await once(child,'exit');
  });
}

test('signal aborts only this relay’s active HTTP operation', async t => {
  const f = await fixture(t); f.mode('hold');
  const call = f.client.callTool({name:'fixture'}).catch(() => {});
  while (!f.posts.some(p=>p.method === 'tools/call')) await new Promise(r=>setTimeout(r,5));
  process.kill(f.transport.pid,'SIGTERM');
  const deadline = Date.now()+2400;
  while (!f.heldClosed() && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.ok(f.heldClosed()); await call;
  assert.equal((await fetch(f.url)).status,405);
});

test('modern auto client probes locally and uses legacy stdio handshake', async t => {
  const f = await fixture(t);
  const {Client: ModernClient} = await import('@modelcontextprotocol/client');
  const {StdioClientTransport: ModernStdio} = await import('@modelcontextprotocol/client/stdio');
  const client = new ModernClient({name:'modern-auto-fixture',version:'1'}, {capabilities:{},versionNegotiation:{mode:'auto'}});
  const transport = new ModernStdio({command:process.execPath,args:['dist/http-client-bridge.js'],env:{...process.env,BAMBU_MCP_HTTP_URL:f.url,BAMBU_MCP_HTTP_TOKEN_FILE:f.tokenFile},stderr:'pipe'});
  t.after(async () => { await client.close().catch(()=>{}); });
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools,[]);
  assert.equal(f.count(),2);
  assert.equal(f.posts.filter(p=>p.method === 'server/discover').length,0);
  assert.equal(f.posts.filter(p=>p.method === 'initialize').at(-1).params.clientInfo.name,'modern-auto-fixture');
});

test('modern probe returns method-not-found with numeric zero and no backend request', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['dist/http-client-bridge.js'], {env:{...process.env,BAMBU_MCP_HTTP_URL:f.url,BAMBU_MCP_HTTP_TOKEN_FILE:f.tokenFile},stdio:['pipe','pipe','pipe']});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:0,method:'server/discover',params:{_meta:{}}})+'\n');
  const [data] = await once(child.stdout,'data');
  assert.deepEqual(JSON.parse(data.toString().trim()), {jsonrpc:'2.0',id:0,error:{code:-32601,message:'Method not found'}});
  assert.equal(f.count(),1); assert.equal(f.posts.filter(p=>p.method === 'server/discover').length,0);
  child.stdin.end(); const [code] = await once(child,'exit'); assert.equal(code,0);
});

test('probe after initialization is local and leaves the legacy session usable', async t => {
  const f = await fixture(t);
  const {EmptyResultSchema} = await import('@modelcontextprotocol/sdk/types.js');
  await assert.rejects(f.client.request({method:'server/discover'},EmptyResultSchema), /Method not found/);
  assert.deepEqual((await f.client.listTools()).tools,[]);
  assert.equal(f.posts.filter(p=>p.method === 'server/discover').length,0);
});
