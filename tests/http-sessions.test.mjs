import assert from "node:assert/strict";
import test from "node:test";
import { request as nodeRequest } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ElicitRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HttpSessions, httpBearerToken } from "../dist/http-sessions.js";
import { withRequestOwner, requestOwner } from "../dist/request-context.js";
import { withPrinterOperation } from "../dist/safety/artifact.js";
import { withOperationSignal } from "../dist/operation-context.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackedMkdtempSync } from "./support/temp.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, overrides = {}) {
  const {callTool, ...runtimeOverrides} = overrides;
  let count = 0;
  const backend = { events: [], entered: new Map(), release: new Map(), cancelled: new Map() };
  const runtime = new HttpSessions({host: "127.0.0.1", port: 0, path: "/mcp", enableJsonResponse: true, allowedOrigins: new Set(), ...runtimeOverrides}, () => {
    count++;
    const server = new Server({name: "http-fixture", version: "1"}, {capabilities: {tools: {}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{name: "owned", inputSchema: {type: "object"}}]}));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => withRequestOwner(server, extra, async () => {
      const args = request.params.arguments ?? {};
      if (callTool) return callTool(args, extra);
      extra.signal.addEventListener("abort", () => backend.cancelled.get(args.id)?.resolve(), {once: true});
      if (args.block) {
        backend.entered.get(args.id)?.resolve();
        await backend.release.get(args.id)?.promise;
      }
      const owner = requestOwner();
      if (args.confirm) {
        const response = await owner.server.elicitInput({mode: "form", message: args.id, requestedSchema: {type: "object", properties: {confirmed: {type: "boolean"}}, required: ["confirmed"]}}, {signal: owner.signal});
        owner.signal.throwIfAborted();
        if (response.action !== "accept" || response.content?.confirmed !== true) throw new Error("No confirmation");
      }
      return withPrinterOperation("fixture", "TEST-SHARED", async assertActive => {
        assertActive(); backend.events.push(args.id);
        return {content: [{type: "text", text: String(args.id)}]};
      });
    }));
    return server;
  });
  await runtime.listen();
  const url = new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`);
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(({client}) => client.close())); await runtime.close(); });
  async function connect(name, handler) {
    const client = new Client({name, version: "1"}, {capabilities: {elicitation: {form: {}}}});
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    const transport = new StreamableHTTPClientTransport(url, {requestInit: overrides.bearerToken ? {headers: {Authorization: `Bearer ${overrides.bearerToken}`}} : undefined});
    clients.push({client, transport}); await client.connect(transport);
    return {client, transport};
  }
  return {runtime, backend, url, connect, count: () => count};
}

test("parallel SDK clients own distinct sessions over one backend; deleting A preserves B and permits C", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.connect("A"), f.connect("B")]);
  assert.notEqual(a.transport.sessionId, b.transport.sessionId);
  const results = await Promise.all([a.client.callTool({name: "owned", arguments: {id: "A"}}), b.client.callTool({name: "owned", arguments: {id: "B"}})]);
  assert.deepEqual(results.map(r => r.content[0].text), ["A", "B"]);
  await a.transport.terminateSession(); await a.client.close();
  assert.equal((await b.client.callTool({name: "owned", arguments: {id: "B2"}})).content[0].text, "B2");
  const c = await f.connect("C");
  assert.equal((await c.client.callTool({name: "owned", arguments: {id: "C"}})).content[0].text, "C");
  assert.equal(f.count(), 3);
  assert.deepEqual(f.backend.events.sort(), ["A", "B", "B2", "C"]);
});

test("interleaved elicitation stays with each originating SDK client", async t => {
  const f = await fixture(t), seenA = [], seenB = [];
  const heldA = deferred(), enteredA = deferred();
  const a = await f.connect("A", async request => { seenA.push(request.params.message); enteredA.resolve(); await heldA.promise; return {action: "accept", content: {confirmed: true}}; });
  const b = await f.connect("B", async request => { seenB.push(request.params.message); return {action: "accept", content: {confirmed: true}}; });
  const pendingA = a.client.callTool({name: "owned", arguments: {id: "only-A", confirm: true}});
  await enteredA.promise;
  assert.equal((await b.client.callTool({name: "owned", arguments: {id: "only-B", confirm: true}})).content[0].text, "only-B");
  heldA.resolve(); await pendingA;
  assert.deepEqual(seenA, ["only-A"]); assert.deepEqual(seenB, ["only-B"]);
});

test("deleting one session revokes its delayed dispatch without replay or cancelling another session", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.backend.entered.set("cancel-A", entered); f.backend.release.set("cancel-A", release);
  const a = await f.connect("A"), b = await f.connect("B");
  const pending = a.client.callTool({name: "owned", arguments: {id: "cancel-A", block: true}}).catch(error => error);
  await entered.promise;
  await a.transport.terminateSession(); await a.client.close();
  release.resolve(); await pending;
  await b.client.callTool({name: "owned", arguments: {id: "B-survives"}});
  await wait(30);
  assert.deepEqual(f.backend.events, ["B-survives"]);
});

test("queued operation cancellation follows only its own signal", async () => {
  const gate = deferred(), started = deferred(), a = new AbortController(), b = new AbortController();
  const events = [];
  const first = withOperationSignal(a.signal, () => withPrinterOperation("fixture", "QUEUE", async active => { started.resolve(); await gate.promise; active(); events.push("A"); }));
  await started.promise;
  const next = withOperationSignal(b.signal, () => withPrinterOperation("fixture", "QUEUE", async active => { active(); events.push("B"); }));
  a.abort(); gate.resolve(); await assert.rejects(first); await next;
  assert.deepEqual(events, ["B"]);
});

test("Host, default Origin and optional bearer checks reject before parsing a body", async t => {
  const f = await fixture(t, {bearerToken: "test-private-token", allowedOrigins: new Set(["https://trusted.example"])});
  const checks = [
    [{Host: "attacker.example"}, 403],
    [{Origin: "https://evil.example"}, 403],
    [{Origin: "null"}, 403],
    [{}, 401],
    [{Authorization: "Bearer wrong"}, 401],
    [{Authorization: "Bearer test-private-token", Origin: "https://trusted.example"}, 400],
  ];
  for (const [headers, expected] of checks) {
    const status = await new Promise((resolve, reject) => {
      const request = nodeRequest(f.url, {method: "POST", headers: {"Content-Type": "application/json", ...headers}}, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end("not-json");
    });
    assert.equal(status, expected);
  }
  assert.equal(f.count(), 0);
  const preflight = await fetch(f.url, {method: "OPTIONS", headers: {Origin: "https://trusted.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://trusted.example");
  assert.equal((await fetch(f.url, {method: "POST", headers: {Origin: "https://trusted.example"}, body: "not-json"})).status, 401);
  const client = await f.connect("allowed"); assert.equal((await client.client.listTools()).tools.length, 1);
  const noBrowser = await fixture(t);
  assert.equal((await fetch(noBrowser.url, {method: "POST", headers: {Origin: "http://localhost"}, body: "not-json"})).status, 403);
});

test("HTTP limits bodies and session count, expires idle sessions, and closes once", async t => {
  const f = await fixture(t, {maxSessions: 1, maxBodyBytes: 1024, idleTimeoutMs: 70});
  const oversized = await fetch(f.url, {method: "POST", body: "x".repeat(1025)});
  assert.equal(oversized.status, 413); await oversized.text();
  const a = await f.connect("A");
  const blocked = new Client({name: "overflow", version: "1"});
  await assert.rejects(blocked.connect(new StreamableHTTPClientTransport(f.url)), /503|Session limit/);
  await blocked.close();
  await a.client.close();
  await wait(170);
  const c = await f.connect("C"); assert.ok(c.transport.sessionId);
  const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing); await closing;
  assert.throws(() => requestOwner(), /No requesting MCP client/);
});

test("bearer token files must be private and configured once; remote binding requires explicit authentication", async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "http-token-test-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, "token"); fs.writeFileSync(file, "private-test-token\n", {mode: 0o600});
  assert.equal(httpBearerToken({MCP_HTTP_BEARER_TOKEN_FILE: file}), "private-test-token");
  assert.throws(() => httpBearerToken({MCP_HTTP_BEARER_TOKEN_FILE: file, MCP_HTTP_BEARER_TOKEN: "also"}), /only one/);
  fs.chmodSync(file, 0o644); assert.throws(() => httpBearerToken({MCP_HTTP_BEARER_TOKEN_FILE: file}), /private/);
  assert.throws(() => httpBearerToken({MCP_HTTP_BEARER_TOKEN: ""}), /nonempty/);
  const config = {host: "0.0.0.0", port: 0, path: "/mcp", enableJsonResponse: true, allowedOrigins: new Set()};
  assert.throws(() => new HttpSessions(config, () => {}), /bearer token/);
  assert.throws(() => new HttpSessions({...config, bearerToken: "token"}, () => {}), /ALLOWED_HOSTS/);
});

test("actual MCP owner shares its Bambu connection store and routes both confirmation callbacks; shutdown owns cleanup once", {timeout: 10_000}, async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "http-owner-test-"));
  const previousEnv = {...process.env}, previousCwd = process.cwd();
  process.chdir(directory);
  for (const key of Object.keys(process.env)) if (/^(BAMBU_|MCP_HTTP_|BLENDER_|FUSION_|CAD_|PRINTER_|TEMP_DIR$)/.test(key)) delete process.env[key];
  Object.assign(process.env, {MCP_TRANSPORT: "streamable-http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0", BAMBU_MODEL: "", BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "01PTESTHTTP", BAMBU_PRINTER_ACCESS_TOKEN: "TEST", CAD_ENABLED: "0", TEMP_DIR: directory});
  const {BambuPrinterMCPServer} = await import("../dist/index.js");
  const {accountManager} = await import("../dist/signing-transport.js");
  const owner = new BambuPrinterMCPServer();
  const backend = owner.bambu, store = backend.printerStore;
  const published = [], cleaned = {printer: 0, camera: 0, login: 0, bridge: 0, fusion: 0, exit: 0};
  const raw = {model: "p1s", gcode_state: "IDLE", nozzle_diameter: "0.4", print_error: 123, hms: [], subtask_name: "test-fixture"};
  const printer = {data: raw, config: {serialNumber: "01PTESTHTTP"}, publish: async value => { published.push(value); }, disconnect: async () => { cleaned.printer++; }};
  store.printers.set("127.0.0.1-01PTESTHTTP-TEST", printer);
  store.reportSnapshots.set("127.0.0.1-01PTESTHTTP-TEST", raw);
  store.reportTimes.set("127.0.0.1-01PTESTHTTP-TEST", Date.now());
  // Only fresh vendor telemetry is synthetic; clearHmsErrors and its actual confirmation callback execute unchanged.
  backend.getSafetyStatus = async (_host, serial) => ({connected: true, model: "p1s", status: "IDLE", serial, raw, observation: {source: "mqtt", receivedAt: Date.now(), requestedAt: Date.now() - 1, identitySource: "report"}});
  t.mock.method(backend.cameraStreams, "stopAll", () => { cleaned.camera++; });
  t.mock.method(accountManager, "cancelInteractiveLogin", () => { cleaned.login++; });
  t.mock.method(owner.bambuNetwork, "stop", async () => { cleaned.bridge++; });
  t.mock.method(owner.fusion, "close", async () => { cleaned.fusion++; });
  t.mock.method(process, "exit", () => { cleaned.exit++; });
  await owner.startHttp();
  const runtime = owner.httpRuntime;
  const url = new URL(`http://127.0.0.1:${runtime.httpServer.address().port}/mcp`);
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(({client}) => client.close())); await runtime.close();
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv); fs.rmSync(directory, {recursive: true, force: true});
  });
  async function connect(name, handler) {
    const client = new Client({name, version: "1"}, {capabilities: {elicitation: {form: {}}}});
    client.setRequestHandler(ElicitRequestSchema, handler);
    const transport = new StreamableHTTPClientTransport(url); clients.push({client, transport});
    await client.connect(transport); return {client, transport};
  }
  const modelEntered = deferred(), releaseModel = deferred(), seenA = [], seenB = [];
  const a = await connect("owner-A", async request => {
    seenA.push(request.params.message);
    if (request.params.requestedSchema.properties.bambu_model) { modelEntered.resolve(); await releaseModel.promise; return {action: "accept", content: {bambu_model: "x2d"}}; }
    return {action: "accept", content: {confirmed: true}};
  });
  const b = await connect("owner-B", async request => { seenB.push(request.params.message); return {action: "accept", content: request.params.requestedSchema.properties.bambu_model ? {bambu_model: "x2d"} : {confirmed: true}}; });
  const results = await Promise.all([a.client.callTool({name: "get_printer_status", arguments: {}}), b.client.callTool({name: "get_printer_status", arguments: {}})]);
  assert.ok(results.every(result => result.isError !== true));
  assert.equal(owner.bambu, backend); assert.equal(backend.printerStore, store); assert.equal(store.printers.size, 1);
  const pendingModel = a.client.callTool({name: "start_print", arguments: {filename: "missing-a.gcode"}});
  await modelEntered.promise;
  const bModel = await b.client.callTool({name: "start_print", arguments: {filename: "missing-b.gcode"}});
  assert.equal(bModel.isError, true); releaseModel.resolve(); await pendingModel;
  assert.equal(seenA.length, 1); assert.equal(seenB.length, 1);
  const clear = await a.client.callTool({name: "clear_hms_errors", arguments: {}});
  assert.notEqual(clear.isError, true); assert.equal(seenA.length, 2); assert.equal(seenB.length, 1);
  assert.ok(published.some(message => message.print?.command === "clean_print_error"));
  const lateEntered = deferred(), lateRelease = deferred(), getPrinter = store.getPrinter.bind(store);
  t.mock.method(store, "getPrinter", async (host, serial, token) => {
    if (serial === "01PDELAYHTTP") { lateEntered.resolve(); await lateRelease.promise; return printer; }
    return getPrinter(host, serial, token);
  });
  const beforeCancelledCommand = published.length;
  const pendingCommand = a.client.callTool({name: "set_print_speed", arguments: {mode: "standard", bambu_serial: "01PDELAYHTTP"}}).catch(error => error);
  await lateEntered.promise;
  await a.transport.terminateSession(); await a.client.close();
  lateRelease.resolve(); await pendingCommand; await wait(20);
  assert.equal(published.length, beforeCancelledCommand, "closed session must not publish when its pending connection resolves");
  assert.deepEqual(cleaned, {printer: 0, camera: 0, login: 0, bridge: 0, fusion: 0, exit: 0});
  assert.notEqual((await b.client.callTool({name: "get_printer_status", arguments: {}})).isError, true);
  const c = await connect("owner-C", async () => ({action: "cancel"})); assert.ok((await c.client.listTools()).tools.length > 0);
  await Promise.all([owner.shutdown(), owner.shutdown()]);
  assert.deepEqual(cleaned, {printer: 1, camera: 1, login: 1, bridge: 1, fusion: 1, exit: 1});
});

test("closed HTTP sessions cannot perform late FTPS deletes or uploads after access, listing or file reads", {timeout: 10_000}, async t => {
  const {BambuImplementation} = await import("../dist/printers/bambu.js");
  const {Client: FtpClient} = await import("basic-ftp");
  const fileSystem = (await import("node:fs/promises")).default;
  const backend = new BambuImplementation();
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "http-ftp-test-"));
  const local = path.join(directory, "fixture.bin"); fs.writeFileSync(local, "synthetic upload bytes");
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const events = [];
  let stage, entered, release, paused = false;
  async function pause(point) { if (stage === point && !paused) { paused = true; entered.resolve(); await release.promise; } }
  t.mock.method(FtpClient.prototype, "access", async () => { await pause("access"); });
  t.mock.method(FtpClient.prototype, "list", async () => { await pause("list"); return []; });
  t.mock.method(FtpClient.prototype, "remove", async remote => { events.push(["delete", remote]); });
  t.mock.method(FtpClient.prototype, "uploadFrom", async (stream, remote) => { for await (const _ of stream) {} events.push(["upload", remote]); });
  t.mock.method(FtpClient.prototype, "close", () => {});
  t.mock.method(backend, "waitForTlsSession", async () => {});
  const read = fileSystem.readFile.bind(fileSystem);
  t.mock.method(fileSystem, "readFile", async (...args) => { if (args[0] === local) await pause("read"); return read(...args); });
  const f = await fixture(t, {callTool: async args => {
    if (args.kind === "delete") await backend.ftpDelete("synthetic.invalid", "TEST", `/cache/${args.id}.bin`);
    else await backend.ftpUpload("synthetic.invalid", "TEST", local, `/cache/${args.id}.bin`);
    return {content: [{type: "text", text: args.id}]};
  }});
  const b = await f.connect("ftp-B");
  for (const [kind, point] of [["delete", "access"], ["upload", "access"], ["upload", "list"], ["upload", "read"]]) {
    stage = point; entered = deferred(); release = deferred(); paused = false;
    const id = `${kind}-${point}-cancelled`, a = await f.connect(`ftp-A-${id}`);
    const pending = a.client.callTool({name: "owned", arguments: {id, kind}}).catch(error => error);
    await entered.promise; await a.transport.terminateSession(); await a.client.close(); release.resolve(); await pending;
    const successful = await b.client.callTool({name: "owned", arguments: {id: `${kind}-${point}-B`, kind}});
    assert.equal(successful.isError, undefined);
    assert.ok(!events.some(([, remote]) => remote.includes(id)), `cancelled ${kind} must not dispatch after ${point}`);
  }
  assert.equal(events.length, 4);
  assert.ok(events.every(([, remote]) => remote.endsWith("-B.bin")));
});

test("repeated SDK request cancellations finish original POSTs and preserve session capacity", {timeout: 15_000}, async t => {
  const f = await fixture(t), a = await f.connect("cancel-many-A"), b = await f.connect("cancel-many-B");
  for (let index = 0; index < 150; index++) {
    const id = `cancel-${index}`, entered = deferred(), release = deferred(), cancelled = deferred(), controller = new AbortController();
    f.backend.entered.set(id, entered); f.backend.release.set(id, release); f.backend.cancelled.set(id, cancelled);
    const pending = a.client.callTool({name: "owned", arguments: {id, block: true}}, undefined, {signal: controller.signal}).catch(error => error);
    await entered.promise; controller.abort(); await pending; await cancelled.promise; release.resolve();
  }
  await wait(50);
  assert.ok(f.runtime.activeRequests <= 2, `only the two live GET streams remain: ${f.runtime.activeRequests}`);
  for (const session of f.runtime.sessions.values()) {
    assert.ok(session.active <= 1, `cancelled POSTs must release session.active: ${session.active}`);
    assert.equal(session.requests.size, 0);
  }
  assert.deepEqual(f.backend.events, []);
  assert.equal((await b.client.callTool({name: "owned", arguments: {id: "B-still-works"}})).content[0].text, "B-still-works");
  await a.transport.terminateSession(); await a.client.close();
  const c = await f.connect("cancel-many-C");
  assert.equal((await c.client.callTool({name: "owned", arguments: {id: "C-new"}})).content[0].text, "C-new");
});

test("at the live HTTP request ceiling, cancellation and DELETE remain available", {timeout: 15_000}, async t => {
  const f = await fixture(t), a = await f.connect("full-A"), b = await f.connect("full-B");
  await wait(30);
  const controllers = [], entered = [], releases = [], pending = [];
  const initial = f.runtime.activeRequests;
  for (let index = 0; index < 128 - initial; index++) {
    const id = `full-${index}`, entry = deferred(), release = deferred(), cancelled = deferred(), controller = new AbortController();
    f.backend.entered.set(id, entry); f.backend.release.set(id, release); f.backend.cancelled.set(id, cancelled);
    entered.push(entry.promise); releases.push(release); controllers.push({controller, cancelled});
    pending.push(a.client.callTool({name: "owned", arguments: {id, block: true}}, undefined, {signal: controller.signal}).catch(error => error));
  }
  await Promise.all(entered); assert.equal(f.runtime.activeRequests, 128);
  controllers[0].controller.abort(); await controllers[0].cancelled.promise; releases[0].resolve();
  await wait(20);
  assert.equal(f.runtime.controlRequests, 0);
  // Refill the freed slot, then DELETE A at the ceiling without waiting for ordinary requests.
  const id = "full-refill", entry = deferred(), release = deferred();
  f.backend.entered.set(id, entry); f.backend.release.set(id, release); releases.push(release);
  pending.push(a.client.callTool({name: "owned", arguments: {id, block: true}}).catch(error => error));
  await entry.promise; assert.equal(f.runtime.activeRequests, 128);
  await a.transport.terminateSession(); await a.client.close();
  releases.forEach(item => item.resolve()); await Promise.all(pending); await wait(30);
  assert.ok(f.runtime.activeRequests <= 1);
  assert.equal((await b.client.callTool({name: "owned", arguments: {id: "B-after-ceiling"}})).content[0].text, "B-after-ceiling");
  const c = await f.connect("full-C"); assert.ok(c.transport.sessionId);
  assert.deepEqual(f.backend.events, ["B-after-ceiling"]);
});

test("HTTP CLI startup stays lazy and SIGTERM performs process cleanup once", {timeout: 10_000}, async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "http-signal-test-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const log = path.join(directory, "cleanup.jsonl"), preload = path.join(directory, "preload.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
import {BambuImplementation} from ${JSON.stringify(pathToFileURL(path.join(root, "dist/printers/bambu.js")).href)};
import {BambuNetworkBridge} from ${JSON.stringify(pathToFileURL(path.join(root, "dist/bambu-network-bridge.js")).href)};
import {FusionMcpBridge} from ${JSON.stringify(pathToFileURL(path.join(root, "dist/fusion-mcp-bridge.js")).href)};
import {accountManager} from ${JSON.stringify(pathToFileURL(path.join(root, "dist/signing-transport.js")).href)};
const record = name => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(name)+"\\n");
BambuImplementation.prototype.getPrinter = async () => {record("unexpected-printer-call"); throw new Error("No printer access in startup test");};
BambuImplementation.prototype.disconnectAll = async () => record("printer");
BambuNetworkBridge.prototype.stop = async () => record("bridge");
FusionMcpBridge.prototype.close = async () => record("fusion");
accountManager.cancelInteractiveLogin = () => record("login");
`);
  const env = {...process.env, MCP_TRANSPORT: "streamable-http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0", MCP_HTTP_STATEFUL: "true", BAMBU_PRINTER_HOST: "fully-configured.invalid", BAMBU_PRINTER_SERIAL: "01PTEST", BAMBU_PRINTER_ACCESS_TOKEN: "SYNTHETIC", BAMBU_MODEL: "p1s", BAMBU_SIGNED_CONTROLS: "0", TEMP_DIR: path.join(directory, "temp")};
  delete env.MCP_HTTP_BEARER_TOKEN; delete env.MCP_HTTP_BEARER_TOKEN_FILE;
  const child = spawn(process.execPath, ["--import", preload, path.join(root, "dist/index.js")], {cwd: directory, env, stdio: ["ignore", "pipe", "pipe"]});
  let stderr = "", stdout = ""; child.stdout.on("data", bytes => { stdout += bytes; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({code, signal})));
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; fs.rmSync(directory, {recursive: true, force: true}); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Startup failed (${code}): ${stderr}`)));
    child.stderr.on("data", bytes => { stderr += bytes; if (stderr.includes("server running on http://")) resolve(); });
  });
  assert.equal(fs.existsSync(log), false, "configured startup must not contact the printer or clean up an active backend");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, {code: 143, signal: null});
  assert.equal(stdout, "");
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.sort(), ["bridge", "fusion", "login", "printer"]);
});

test("wire IDs 0 and empty string cancel real Bambu operations, permit safe reuse and do not alter server elicitation ID 0", {timeout: 10_000}, async t => {
  const {BambuImplementation} = await import("../dist/printers/bambu.js");
  const backend = new BambuImplementation(), events = [], entries = new Map(), gates = new Map(), settled = new Map();
  t.mock.method(backend, "getPrinter", async (_host, serial) => {
    entries.get(serial)?.resolve(); await gates.get(serial)?.promise;
    return {publish: async () => { events.push(serial); }};
  });
  const f = await fixture(t, {callTool: async args => {
    try {
      if (args.confirm) {
        const {server, signal} = requestOwner();
        const response = await server.elicitInput({mode: "form", message: args.id, requestedSchema: {type: "object", properties: {confirmed: {type: "boolean"}}, required: ["confirmed"]}}, {signal});
        assert.equal(response.action, "accept");
      }
      await backend.setPrintSpeed("synthetic.invalid", args.id, "TEST", "standard");
      return {content: [{type: "text", text: args.id}]};
    } finally { settled.get(args.id)?.resolve(); }
  }});
  const serverIds = [];
  const a = await f.connect("raw-id-A", async (_request, extra) => { serverIds.push(extra.requestId); return {action: "accept", content: {confirmed: true}}; });
  const b = await f.connect("raw-id-B");
  const headers = {"Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": a.transport.sessionId, "MCP-Protocol-Version": "2025-03-26"};
  function post(message) { return fetch(f.url, {method: "POST", headers, body: JSON.stringify(message)}); }
  for (const id of [0, ""]) {
    const label = id === 0 ? "zero" : "empty", old = `old-${label}`, next = `new-${label}`;
    const entered = deferred(), release = deferred(), ended = deferred(); entries.set(old, entered); gates.set(old, release); settled.set(old, ended);
    const pending = post({jsonrpc: "2.0", id, method: "tools/call", params: {name: "owned", arguments: {id: old, confirm: true}}});
    await entered.promise;
    assert.equal((await post({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId: id}})).status, 202);
    const cancelled = await pending; assert.equal(cancelled.status, 200);
    const terminal = await cancelled.json(); assert.equal(terminal.id, id); assert.equal(terminal.error.message, "Request cancelled");
    const reused = post({jsonrpc: "2.0", id, method: "tools/call", params: {name: "owned", arguments: {id: next}}});
    release.resolve(); await ended.promise;
    const result = await (await reused).json(); assert.equal(result.id, id); assert.equal(result.result.content[0].text, next);
  }
  assert.equal(serverIds[0], 0, "server-initiated elicitation keeps SDK ID 0 despite the simultaneous client request ID 0");
  assert.deepEqual(events, ["new-zero", "new-empty"]);
  assert.equal((await b.client.callTool({name: "owned", arguments: {id: "B-after-raw-cancellation"}})).content[0].text, "B-after-raw-cancellation");
  assert.deepEqual(events, ["new-zero", "new-empty", "B-after-raw-cancellation"]);
});

test("SSE progress retains the client progress token and originating HTTP request", async t => {
  const seen = [];
  const f = await fixture(t, {enableJsonResponse: false, callTool: async (args, extra) => {
    assert.equal(typeof extra.requestId, "string");
    assert.match(extra.requestId, /^client-/);
    assert.equal(typeof extra._meta.progressToken, "number");
    await extra.sendNotification({method: "notifications/progress", params: {progressToken: extra._meta.progressToken, progress: 1, total: 2, message: args.id}});
    return {content: [{type: "text", text: args.id}]};
  }});
  const a = await f.connect("progress-A"), b = await f.connect("progress-B");
  const results = await Promise.all([a.client.callTool({name: "owned", arguments: {id: "only-A-progress"}}, undefined, {onprogress: value => seen.push(["A", value.message])}), b.client.callTool({name: "owned", arguments: {id: "only-B-progress"}}, undefined, {onprogress: value => seen.push(["B", value.message])})]);
  assert.deepEqual(results.map(result => result.content[0].text), ["only-A-progress", "only-B-progress"]);
  assert.deepEqual(seen.sort(), [["A", "only-A-progress"], ["B", "only-B-progress"]]);
});
