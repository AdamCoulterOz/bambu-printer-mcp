import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ElicitRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = 'fixture-private-token';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-test-')); const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, token, {mode: 0o600});
  const sessions = new Map(); let failStatus = 0; let drop = false; let rpcError = false; let streamLoss = false; let redirect = false; const posts = []; const deletions = [];
  const web = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const msg = JSON.parse(Buffer.concat(chunks)); posts.push(msg);
      if (failStatus && msg.method === 'tools/call') { res.writeHead(failStatus).end(); return; }
      if (redirect && msg.method === 'tools/call') { res.writeHead(307, {location: '/mcp'}).end(); return; }
      if (streamLoss && msg.method === 'tools/call') { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end('id: 1\n\n'); return; }
      if (rpcError && msg.method === 'tools/call') { rpcError = false; res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(`id: 1\ndata: ${JSON.stringify({jsonrpc: '2.0', id: msg.id, error: {code: -32603, message: 'fixture error'}})}\n\n`); return; }
      if (drop && msg.method === 'tools/call') { req.socket.destroy(); return; }
      let transport = sessions.get(req.headers['mcp-session-id']);
      if (!transport && msg.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({sessionIdGenerator: randomUUID, enableJsonResponse: false, onsessioninitialized: id => sessions.set(id, transport)});
        const server = new Server({name: 'fixture', version: '1'}, {capabilities: {tools: {}, resources: {}, prompts: {}}, instructions: 'fixture instructions'});
        server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{name: 'fixture', inputSchema: {type: 'object'}}]}));
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources: [{name: 'resource', uri: 'fixture://resource'}]}));
        server.setRequestHandler(ListPromptsRequestSchema, async () => ({prompts: [{name: 'prompt'}]}));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          if (request.params.arguments?.cancel) {
            await new Promise(resolve => extra.signal.addEventListener('abort', resolve, {once: true}));
            return {content: [{type: 'text', text: 'cancelled'}]};
          }
          if (request.params.arguments?.elicit) {
            await extra.sendNotification({method: 'notifications/progress', params: {progressToken: request.params._meta.progressToken, progress: 1}});
            const result = await server.elicitInput({mode: 'form', message: 'confirm fixture', requestedSchema: {type: 'object', properties: {ok: {type: 'boolean'}}}});
            return {content: [{type: 'text', text: result.action}]};
          }
          return {content: [{type: 'text', text: 'ok'}]};
        });
        await server.connect(transport);
      }
      if (!transport) { res.writeHead(404).end(); return; }
      await transport.handleRequest(req, res, msg); return;
    }
    const id = req.headers['mcp-session-id']; const transport = sessions.get(id);
    if (!transport) { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { deletions.push(id); sessions.delete(id); }
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${web.address().port}/mcp`;
  const clients = [];
  t.after(async () => { for (const c of clients) await c.close().catch(() => {}); for (const s of sessions.values()) await s.close(); await new Promise(resolve => web.close(resolve)); await rm(dir, {recursive: true, force: true}); });
  async function connect() {
    const client = new Client({name: 'fixture-client', version: '1'}, {capabilities: {elicitation: {form: {}}}});
    const transport = new StdioClientTransport({command: process.execPath, args: ['dist/http-client-bridge.js'], env: {...process.env, BAMBU_MCP_HTTP_URL: url, BAMBU_MCP_HTTP_TOKEN_FILE: tokenFile}, stderr: 'pipe'});
    clients.push(client); await client.connect(transport); return {client, transport};
  }
  return {url, tokenFile, dir, connect, posts, deletions, sessions, fail: n => {failStatus = n;}, drop: () => {drop = true;}, rpcError: () => {rpcError = true;}, streamLoss: () => {streamLoss = true;}, redirect: () => {redirect = true;}};
}

test('raw relay preserves capabilities, instructions, lists, elicitation, progress and session isolation', async t => {
  const f = await fixture(t), a = await f.connect(), b = await f.connect();
  assert.equal(a.client.getInstructions(), 'fixture instructions');
  assert.equal((await a.client.listTools()).tools[0].name, 'fixture');
  assert.equal((await a.client.listResources()).resources[0].uri, 'fixture://resource');
  assert.equal((await a.client.listPrompts()).prompts[0].name, 'prompt');
  let elicited = false, progress = false;
  a.client.setRequestHandler(ElicitRequestSchema, async () => {elicited = true; return {action: 'accept', content: {ok: true}};});
  const result = await a.client.callTool({name: 'fixture', arguments: {elicit: true}, _meta: {progressToken: 'p'}}, undefined, {onprogress: () => {progress = true;}});
  assert.equal(result.content[0].text, 'accept'); assert.ok(elicited); assert.ok(progress);
  const controller = new AbortController();
  const cancelled = a.client.callTool({name: 'fixture', arguments: {cancel: true}}, undefined, {signal: controller.signal});
  while (!f.posts.some(p => p.method === 'tools/call' && p.params.arguments?.cancel)) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); await assert.rejects(cancelled);
  while (!f.posts.some(p => p.method === 'notifications/cancelled')) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await a.client.callTool({name: 'fixture'})).content[0].text, 'ok');
  assert.equal(f.posts.filter(p => p.method === 'notifications/cancelled').length, 1);
  await a.client.close();
  assert.equal(f.deletions.length, 1);
  assert.equal((await b.client.callTool({name: 'fixture'})).content[0].text, 'ok');
});

for (const status of [401, 404, 500]) test(`HTTP ${status} does not replay a request`, async t => {
  const f = await fixture(t), a = await f.connect(); f.fail(status);
  await assert.rejects(a.client.callTool({name: 'fixture'}));
  assert.equal(f.posts.filter(p => p.method === 'tools/call').length, 1);
});
test('dropped mutation is never resent', async t => {
  const f = await fixture(t), a = await f.connect(); f.drop();
  await assert.rejects(a.client.callTool({name: 'fixture'}));
  assert.equal(f.posts.filter(p => p.method === 'tools/call').length, 1);
});
test('insecure and symlink token files fail without writing secrets to stdout', async t => {
  const f = await fixture(t); await chmod(f.tokenFile, 0o644); const link = join(f.dir, 'link'); await symlink(f.tokenFile, link);
  for (const file of [f.tokenFile, link]) {
    const child = spawn(process.execPath, ['dist/http-client-bridge.js'], {env: {...process.env, BAMBU_MCP_HTTP_URL: f.url, BAMBU_MCP_HTTP_TOKEN_FILE: file}, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = ''; child.stdout.on('data', b => {stdout += b;}); child.stderr.on('data', b => {stderr += b;});
    const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.equal(stdout, ''); assert.ok(!stderr.includes(token));
  }
});

test('SSE JSON-RPC error is forwarded once without terminating a healthy session', async t => {
  const f = await fixture(t), a = await f.connect(); f.rpcError();
  await assert.rejects(a.client.callTool({name: 'fixture'}), /fixture error/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await a.client.callTool({name: 'fixture'})).content[0].text, 'ok');
  assert.equal(f.posts.filter(p => p.method === 'tools/call').length, 2);
});

for (const mode of ['streamLoss', 'redirect']) test(`${mode} fails without replay`, async t => {
  const f = await fixture(t), a = await f.connect(); f[mode]();
  await assert.rejects(a.client.callTool({name: 'fixture'}));
  assert.equal(f.posts.filter(p => p.method === 'tools/call').length, 1);
});
