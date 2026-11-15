import {trackedMkdtemp} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { printWithBambuNative, sendCommandWithBambuNative } from "../dist/bambu-native.js";

const options = { host: "127.0.0.1", serial: "20PDISPATCH", token: "DUMMY", filePath: "/tmp/dummy.3mf",
  projectName: "test", presetName: "test", plateIndex: 0, bedType: "textured_plate", useAMS: false };
const controlOptions = print => ({ ...options, messageJson: JSON.stringify({ print }) });
const hazardousCommands = [
  { command: "set_bed_temp", sequence_id: "1", temp: 60 },
  { command: "set_nozzle_temp", sequence_id: "1", extruder_index: 0, target_temp: 200 },
  { command: "resume", sequence_id: "1" },
  { command: "clean_print_error", sequence_id: "1" },
];

async function helper(t, { attempts = 1, ignoreTerm = false, noRequest = false, legacy = false, crash = false, printResult = 0, ordinaryExit = false, silentSuccess = false, extraReceipt = false, malformedReceipt = false, conflictingReceipts = false, firstReceipt = '' } = {}) {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-native-dispatch-"));
  const events = path.join(directory, "events.jsonl");
  const executable = path.join(directory, "helper.mjs");
  await fs.writeFile(events, "");
  await fs.writeFile(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const record = value => appendFileSync(${JSON.stringify(events)}, JSON.stringify(value)+'\\n');
record({kind:'started',pid:process.pid,mode:process.argv[2]});
if (${ignoreTerm}) process.on('SIGTERM',()=>{});
if (${legacy}) {
  if(!['--print','--command'].includes(process.argv[2])) process.exit(2);
  record({kind:'dispatched',attempt:1});
  process.exit(0);
}
if (['--print-authorized','--command-authorized'].includes(process.argv[2]) && !${noRequest}) {
  const lines = createInterface({input:process.stdin})[Symbol.asyncIterator]();
  for(let attempt=1; attempt<=${attempts}; attempt++) {
    console.log('native_dispatch_request='+attempt);
    const response = await lines.next();
    if(response.value !== 'native_dispatch_authorized='+attempt) process.exit(3);
    record({kind:'dispatched',attempt});
    if (attempt===1 && ${JSON.stringify(firstReceipt)}==='negative') console.log('native_print result=-4030');
    if (attempt===1 && ${JSON.stringify(firstReceipt)}==='success') console.log('native_print result=0');
  }
}
if (${conflictingReceipts}) {console.log('native_print result=0');console.log('native_print result=-1');process.exit(1);}
if (${ordinaryExit}) process.exit(1);
if (${silentSuccess}) process.exit(0);
if (${extraReceipt}) console.log('native_print result=-4030');
console.log('native_print result='+${printResult}+(${malformedReceipt}?' arbitrary-suffix':''));
if (${crash}) process.kill(process.pid, 'SIGTERM');
else process.exit(${printResult} === 0 ? 0 : 20);
`, { mode: 0o755 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = process.env.BAMBU_NATIVE_HELPER;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.BAMBU_NATIVE_HELPER = executable;
  t.after(async () => {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return async () => (await fs.readFile(events, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("native printing requires a fresh-state callback before starting the helper", async t => {
  const events = await helper(t, { noRequest: true });
  await assert.rejects(printWithBambuNative(options), /beforeDispatch|fresh.*state/i);
  assert.deepEqual(await events(), []);
});

test("native print waits for fresh validation at every helper dispatch attempt", async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  const result = await printWithBambuNative(options, undefined, { beforeDispatch: async () => {
    assert.equal((await events()).filter(e => e.kind === "dispatched").length, checks);
    checks++;
  } });
  assert.equal(result.status, "success");
  assert.equal(checks, 2);
  assert.deepEqual((await events()).filter(e => e.kind === "dispatched").map(e => e.attempt), [1, 2]);
});

for (const rejectAt of [1, 2]) test(`native validation failure prevents dispatch attempt ${rejectAt}`, async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {
    if (++checks === rejectAt) throw new Error("Fresh printer state is RUNNING");
  } }), /Fresh printer safety check failed \(state\)/);
  assert.equal(checks, rejectAt);
  assert.equal((await events()).filter(e => e.kind === "dispatched").length, rejectAt - 1);
});

test("native helper cannot report successful printing without dispatch authorization", async t => {
  await helper(t, { noRequest: true });
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {} }), /authorization/i);
});

test("a helper built before dispatch authorization rejects printing before dispatch", async t => {
  const events = await helper(t, { legacy: true });
  await assert.rejects(printWithBambuNative(options, undefined, { beforeDispatch: async () => {} }), /failed \(2\)/i);
  assert.equal((await events()).some(e => e.kind === "dispatched"), false);
});

for (const command of hazardousCommands) test(`native ${command.command} requires a fresh-state callback before helper launch`, async t => {
  const events = await helper(t, { noRequest: true });
  await assert.rejects(sendCommandWithBambuNative(controlOptions(command)), /beforeDispatch|fresh.*state/i);
  assert.deepEqual(await events(), []);
});

test("native hazardous command waits for fresh validation before every send attempt", async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  const result = await sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), { beforeDispatch: async () => {
    assert.equal((await events()).filter(e => e.kind === "dispatched").length, checks);
    checks++;
  } });
  assert.equal(result.status, "success");
  assert.equal(checks, 2);
  assert.deepEqual((await events()).filter(e => e.kind === "dispatched").map(e => e.attempt), [1, 2]);
});

for (const rejectAt of [1, 2]) test(`native command validation failure prevents send attempt ${rejectAt}`, async t => {
  const events = await helper(t, { attempts: 2 });
  let checks = 0;
  await assert.rejects(sendCommandWithBambuNative(controlOptions(hazardousCommands[3]), { beforeDispatch: async () => {
    if (++checks === rejectAt) throw new Error("New printer hardware error requires confirmation");
  } }), /New printer hardware error/);
  assert.equal(checks, rejectAt);
  assert.equal((await events()).filter(e => e.kind === "dispatched").length, rejectAt - 1);
});

test("old helpers reject authorized commands before dispatch", async t => {
  const events = await helper(t, { legacy: true });
  await assert.rejects(sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), { beforeDispatch: async () => {} }), /failed \(2\)/i);
  assert.equal((await events()).some(e => e.kind === "dispatched"), false);
});

test("stop and both heater-off commands remain available without fresh-state authorization", async t => {
  const events = await helper(t);
  for (const command of [{ command: "stop" },
    { command: "set_bed_temp", sequence_id: "1", temp: 0 },
    { command: "set_nozzle_temp", sequence_id: "1", extruder_index: 0, target_temp: 0 }]) {
    assert.equal((await sendCommandWithBambuNative(controlOptions(command))).status, "success");
  }
  assert.deepEqual((await events()).map(e => e.mode), ["--command", "--command", "--command"]);
});

for (const operation of ["print", "command"]) for (const emergency of [false, true]) test(`${emergency ? "stop" : "request cancellation"} interrupts a ${operation} helper waiting for fresh state`, async t => {
  const events = await helper(t, { ignoreTerm: true });
  const controller = new AbortController();
  let reached;
  const checking = new Promise(resolve => { reached = resolve; });
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const execution = { signal: controller.signal, beforeDispatch: async () => { reached(); await wait; } };
  const pending = operation === "print" ? printWithBambuNative(options, undefined, execution)
    : sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), execution);
  const rejected = assert.rejects(pending, /cancelled/i);
  await checking;
  if (emergency) await sendCommandWithBambuNative({ ...options, messageJson: JSON.stringify({print:{command:"stop"}}) });
  else controller.abort();
  await rejected;
  finish();
  const recorded = await events();
  assert.equal(recorded.some(e => e.kind === "dispatched"), false);
  const pid = recorded.find(e => e.mode === `--${operation}-authorized`).pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("compiled native operation requires renewed parent approval after certificate setup and retry", async t => {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-native-cpp-dispatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, "driver.cpp");
  const executable = path.join(directory, "helper");
  const source = fileURLToPath(new URL("../native/bambu-native-print.cpp", import.meta.url));
  // Exercise the real runOperation, including certificate waits and the retry.
  // Only the proprietary plug-in's function pointers are replaced; no library
  // is loaded and none of these callbacks creates a network connection.
  await fs.writeFile(driver, `
#define main unused_native_main
#include ${JSON.stringify(source)}
#undef main
BBL::OnLocalConnectedFn connected;
int main(int argc, char **argv) {
  NativeApi api;
  api.createAgent = [](std::string) -> void* { return reinterpret_cast<void*>(1); };
  api.destroyAgent = [](void*) { if(boolEnv("STUB_CRASH_TEARDOWN",false)) std::abort(); return 0; };
  api.setConfigDir = [](void*,std::string) { return 0; };
  api.initLog = [](void*) { return 0; };
  api.setCertFile = [](void*,std::string,std::string) { return 0; };
  api.setCountryCode = [](void*,std::string) { return 0; };
  api.start = [](void*) { return 0; };
  api.setQueueOnMain = [](void*,std::function<void(std::function<void()>)>) { return 0; };
  api.setPrinterConnected = [](void*,std::function<void(std::string)>) { return 0; };
  api.setLocalConnect = [](void*,BBL::OnLocalConnectedFn callback) { connected=callback; return 0; };
  api.setMessage = [](void*,std::function<void(std::string,std::string)>) { return 0; };
  api.setLocalMessage = api.setMessage;
  api.updateCert = [](void*) { return 0; };
  api.installDeviceCert = [](void*,std::string,bool) {};
  api.connectPrinter = [](void*,std::string serial,std::string,std::string,std::string,bool) { connected(0,serial,""); return 0; };
  api.sendMessageToPrinter = [](void*,std::string,std::string message,int,int) {
    if(message != envOr("BAMBU_NATIVE_COMMAND_JSON")) return 0;
    static int attempts=0; outputLine("stub_control_dispatch="+std::to_string(++attempts)); return attempts==1 ? -4030 : 0;
  };
  api.startLocalPrint = [](void*,BBL::PrintParams,BBL::OnUpdateStatusFn,BBL::WasCancelledFn) {
    static int attempts=0; outputLine("stub_dispatch="+std::to_string(++attempts)); return attempts==1 ? -4030 : 0;
  };
  setenv("BAMBU_NATIVE_CONFIRM","1",1);
  setenv("BAMBU_NATIVE_COMMAND_CONFIRM","1",1);
  setenv("BAMBU_NATIVE_CERT_RETRY_SECONDS","1",1);
  setenv("BAMBU_NATIVE_CONTROL_RETRY_MS","250",1);
  const auto operation = argc==2 && std::string(argv[1])=="--command-authorized"
    ? NativeOperation::AuthorizedCommand : NativeOperation::Print;
  try { runOperation(api,operation); return 0; }
  catch(const std::exception &error) { std::cerr<<error.what()<<std::endl; return 1; }
}
`);
  const compiled = spawnSync(process.env.CXX || "c++", ["-std=c++17", "-O0", driver, "-o", executable, "-ldl", "-pthread"], { encoding: "utf8", timeout: 60000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  const file = path.join(directory, "test.3mf");
  await fs.writeFile(file, "stub plug-in never reads this fixture");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previous = process.env.BAMBU_NATIVE_HELPER;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.BAMBU_NATIVE_HELPER = executable;
  t.after(() => {
    Object.defineProperty(process, "platform", platform);
    if (previous === undefined) delete process.env.BAMBU_NATIVE_HELPER;
    else process.env.BAMBU_NATIVE_HELPER = previous;
  });
  let checks = 0;
  const updates = [];
  await assert.rejects(printWithBambuNative({ ...options, filePath: file }, line => updates.push(line), {
    beforeDispatch: async () => {
      checks++;
      if (checks === 2) throw new Error("Printer became busy before certificate retry");
    },
  }), /Fresh printer safety check failed \(state\)/);
  assert.equal(checks, 2);
  assert.deepEqual(updates.filter(line => line.startsWith("stub_dispatch=")), [], "raw helper text is not exposed");

  const teardownCrash = spawnSync(executable, [], {
    env: {...process.env, STUB_CRASH_TEARDOWN:'1', BAMBU_NATIVE_HOST:'127.0.0.1',
      BAMBU_NATIVE_SERIAL:'20PDISPATCH', BAMBU_NATIVE_ACCESS_CODE:'DUMMY', BAMBU_NATIVE_FILE:file},
    encoding:'utf8', timeout:15000, input:'native_dispatch_authorized=1\nnative_dispatch_authorized=2\n',
  });
  assert.equal(teardownCrash.status,0,teardownCrash.stderr);
  assert.match(teardownCrash.stdout,/native_print result=0/);

  const noParent = spawnSync(executable, [], { env: { ...process.env, BAMBU_NATIVE_HOST: "127.0.0.1",
    BAMBU_NATIVE_SERIAL: "20PDISPATCH", BAMBU_NATIVE_ACCESS_CODE: "DUMMY", BAMBU_NATIVE_FILE: file },
    encoding: "utf8", timeout: 15000, input: "" });
  assert.equal(noParent.status, 1, noParent.error?.message || noParent.stderr);
  assert.match(noParent.stderr, /authorization was missing or rejected/);
  assert.doesNotMatch(noParent.stdout, /stub_dispatch=/);

  let commandChecks = 0;
  const commandResult = await sendCommandWithBambuNative(controlOptions(hazardousCommands[0]), {
    beforeDispatch: async () => { commandChecks++; },
  });
  assert.equal(commandChecks, 2);
  assert.deepEqual(commandResult.updates.filter(line => line.startsWith("stub_control_dispatch=")),
    ["stub_control_dispatch=1", "stub_control_dispatch=2"]);

  // The native retry itself must block without a second parent approval.
  const noRetryApproval = spawnSync(executable, ["--command-authorized"], {
    env: { ...process.env, BAMBU_NATIVE_HOST: "127.0.0.1",
      BAMBU_NATIVE_SERIAL: "20PDISPATCH", BAMBU_NATIVE_ACCESS_CODE: "DUMMY",
      BAMBU_NATIVE_COMMAND_JSON: controlOptions(hazardousCommands[3]).messageJson },
    encoding: "utf8", timeout: 15000, input: "native_dispatch_authorized=1\n",
  });
  assert.equal(noRetryApproval.status, 1, noRetryApproval.error?.message || noRetryApproval.stderr);
  assert.match(noRetryApproval.stderr, /authorization was missing or rejected/);
  assert.match(noRetryApproval.stdout, /stub_control_dispatch=1/);
  assert.doesNotMatch(noRetryApproval.stdout, /stub_control_dispatch=2/);
});

for (const printResult of [0, null]) test(`native crash after authorized dispatch (${printResult}) warns against duplicate printing`, async t => {
  const events = await helper(t, { crash: true, printResult });
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch: async () => {}}), /uncertain.*may.*accepted.*before retrying/i);
  assert.equal((await events()).filter(e => e.kind === 'dispatched').length, 1);
});
test('native crash cannot bypass dispatch authorization even with a success receipt', async t => {
  await helper(t, {crash:true,noRequest:true});
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch:async()=>{}}), /authorization/i);
});
test('explicit native print rejection remains a failure', async t => {
  await helper(t, {printResult:-1});
  await assert.rejects(printWithBambuNative(options, undefined, {beforeDispatch:async()=>{}}), /failed.*20/);
});

test("compiled native command exits cleanly even when plug-in teardown would crash at process exit", { skip: process.platform === "win32" }, async t => {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-native-exit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, "driver.cpp");
  const executable = path.join(directory, "helper");
  const source = fileURLToPath(new URL("../native/bambu-native-print.cpp", import.meta.url));
  // A plug-in whose worker threads outlive destroy_agent crashed one-shot runs
  // in process-exit destructors (SIGSEGV on Linux). Simulate that destructor:
  // a normal exit would abort, the helper must end before it runs.
  await fs.writeFile(driver, `
#define main unused_native_main
#include ${JSON.stringify(source)}
#undef main
BBL::OnLocalConnectedFn connected;
int main() {
  std::atexit([] { std::abort(); });
  NativeApi api;
  api.createAgent = [](std::string) -> void* { return reinterpret_cast<void*>(1); };
  api.destroyAgent = [](void*) { outputLine("stub_destroy_agent"); return 0; };
  api.setConfigDir = [](void*,std::string) { return 0; };
  api.initLog = [](void*) { return 0; };
  api.setCertFile = [](void*,std::string,std::string) { return 0; };
  api.setCountryCode = [](void*,std::string) { return 0; };
  api.start = [](void*) { return 0; };
  api.setQueueOnMain = [](void*,std::function<void(std::function<void()>)>) { return 0; };
  api.setPrinterConnected = [](void*,std::function<void(std::string)>) { return 0; };
  api.setLocalConnect = [](void*,BBL::OnLocalConnectedFn callback) { connected=callback; return 0; };
  api.setMessage = [](void*,std::function<void(std::string,std::string)>) { return 0; };
  api.setLocalMessage = api.setMessage;
  api.updateCert = [](void*) { return 0; };
  api.installDeviceCert = [](void*,std::string,bool) {};
  api.connectPrinter = [](void*,std::string serial,std::string,std::string,std::string,bool) { connected(0,serial,""); return 0; };
  api.sendMessageToPrinter = [](void*,std::string,std::string,int,int) { return std::atoi(envOr("STUB_SEND_RESULT","0").c_str()); };
  try { runOperation(api, NativeOperation::Command); }
  catch(const std::exception &error) { std::cerr<<error.what()<<std::endl; return 1; }
  return 0;
}
`);
  const compiled = spawnSync(process.env.CXX || "c++", ["-std=c++17", "-O0", driver, "-o", executable, "-ldl", "-pthread"], { encoding: "utf8", timeout: 60000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  const env = { ...process.env, BAMBU_NATIVE_HOST: "127.0.0.1", BAMBU_NATIVE_SERIAL: "20PEXIT", BAMBU_NATIVE_ACCESS_CODE: "DUMMY",
    BAMBU_NATIVE_COMMAND_CONFIRM: "1", BAMBU_NATIVE_COMMAND_JSON: JSON.stringify({ print: { command: "pause", sequence_id: "1" } }) };
  const sent = spawnSync(executable, [], { encoding: "utf8", timeout: 15000, env });
  assert.equal(sent.signal, null, sent.stderr);
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /native_command result=0\nstub_destroy_agent\n/, "plug-in cleanup still runs before exit");
  const refused = spawnSync(executable, [], { encoding: "utf8", timeout: 15000, env: { ...env, STUB_SEND_RESULT: "-1" } });
  assert.equal(refused.signal, null, refused.stderr);
  assert.equal(refused.status, 20, "a refused command keeps its failure code");
});

async function diagnosticHelper(t, { hang = true } = {}) {
  const directory = await trackedMkdtemp(path.join(os.tmpdir(), 'bambu-native-diag-'));
  const executable = path.join(directory, 'helper.mjs'), events = path.join(directory, 'events.jsonl');
  await fs.writeFile(events, '');
  await fs.writeFile(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'started',pid:process.pid})+'\\n');
process.on('SIGTERM',()=>{});
console.log('native_connect status=0 dev=PRIVATE_SERIAL msg=PRIVATE_TOKEN');
console.log('native_update_cert result=0 stage=connected');
console.log('native_update status=1 code=12 msg=PRIVATE_TOKEN');
console.log('native_dispatch_request=1');
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const result=await lines.next();
if(result.value==='native_dispatch_authorized=1')appendFileSync(${JSON.stringify(events)},JSON.stringify({kind:'dispatched'})+'\\n');
${hang ? 'setInterval(()=>{},1000);' : "console.log('native_print result=0');process.exit(0);"}
`, {mode:0o755});
  const platform=Object.getOwnPropertyDescriptor(process,'platform'), previous=process.env.BAMBU_NATIVE_HELPER;
  Object.defineProperty(process,'platform',{value:'darwin'});process.env.BAMBU_NATIVE_HELPER=executable;
  t.after(async()=>{Object.defineProperty(process,'platform',platform);if(previous===undefined)delete process.env.BAMBU_NATIVE_HELPER;else process.env.BAMBU_NATIVE_HELPER=previous;await fs.rm(directory,{recursive:true,force:true});});
  return async()=>{const text=await fs.readFile(events,'utf8');return text.trim().split('\n').filter(Boolean).map(JSON.parse)};
}

test('native deadline revokes pending authorization, waits for termination and retains safe stages', async t => {
  const events=await diagnosticHelper(t);let release,entered;
  const wait=new Promise(resolve=>{release=resolve}), pendingCheck=new Promise(resolve=>{entered=resolve});
  const updates=[];const started=Date.now();let hooks=0;
  const work=printWithBambuNative(options,line=>updates.push(line),{timeoutMs:5000,beforeDispatch:async()=>{entered();await wait;},onDispatchAuthorized:()=>{hooks++}});
  const rejection=assert.rejects(work,error=>{
    assert.match(error.message,/timed out/i);assert.equal(error.name,'NativeOperationError');
    assert.equal(error.diagnostics.phase,'authorization_pending');assert.equal(error.diagnostics.authorizationRequests,1);assert.equal(error.diagnostics.authorizedAttempts,0);
    assert.ok(error.diagnostics.events.some(event=>event.stage==='printer_connection'));
    assert.ok(error.diagnostics.events.some(event=>event.stage==='certificate_update'));
    assert.ok(error.diagnostics.events.some(event=>event.stage==='progress'&&event.status===1&&event.code===12));
    assert.doesNotMatch(JSON.stringify(error.diagnostics)+error.message,/PRIVATE_TOKEN|PRIVATE_SERIAL/);
    return true;
  });
  await Promise.race([pendingCheck,rejection.then(()=>{throw Error('helper expired before the safety callback')})]);await rejection;assert.ok(Date.now()-started<15000);
  const all=await events();assert.throws(()=>process.kill(all[0].pid,0),{code:'ESRCH'});
  release();await new Promise(resolve=>setTimeout(resolve,100));assert.equal((await events()).some(e=>e.kind==='dispatched'),false);assert.equal(hooks,0);
  assert.doesNotMatch(JSON.stringify(updates),/PRIVATE_TOKEN|PRIVATE_SERIAL/);
});

test('native safety callback failure reports only a safe cause classification',async t=>{
  const events=await diagnosticHelper(t);const updates=[];
  await assert.rejects(printWithBambuNative(options,line=>updates.push(line),{timeoutMs:10000,beforeDispatch:async()=>{throw Error('connection timeout PRIVATE_TOKEN PRIVATE_SERIAL')}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.equal(error.diagnostics.phase,'safety_check_failed');assert.equal(error.diagnostics.safetyReason,'connection-timeout');
    assert.doesNotMatch(JSON.stringify(error.diagnostics)+error.message,/PRIVATE_TOKEN|PRIVATE_SERIAL/);return true;
  });
  assert.equal((await events()).some(e=>e.kind==='dispatched'),false);assert.doesNotMatch(JSON.stringify(updates),/PRIVATE_TOKEN|PRIVATE_SERIAL/);
});

test('native successful print updates omit arbitrary plug-in content',async t=>{
  await diagnosticHelper(t,{hang:false});const updates=[];
  const result=await printWithBambuNative(options,line=>updates.push(line),{timeoutMs:10000,beforeDispatch:async()=>{}});
  assert.equal(result.status,'success');assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(updates),/PRIVATE_TOKEN|PRIVATE_SERIAL/);
  assert.ok(updates.some(line=>line==='native_update status=1 code=12 msg=progress'));
});


test('native dispatch bookkeeping happens only after safety and before the helper receives authorization',async t=>{
  const events=await helper(t);let hooks=0;
  const result=await printWithBambuNative(options,undefined,{beforeDispatch:async()=>{assert.equal(hooks,0)},onDispatchAuthorized:()=>{hooks++}});
  assert.equal(result.status,'success');assert.equal(hooks,1);assert.equal((await events()).filter(e=>e.kind==='dispatched').length,1);
});

test('known printer refusal retains its stable code without echoing unsafe detail',async t=>{
  await diagnosticHelper(t);const {PrinterRefusal}=await import('../dist/refusal.js');
  await assert.rejects(printWithBambuNative(options,undefined,{timeoutMs:10000,beforeDispatch:async()=>{throw new PrinterRefusal('printer-not-ready','PRIVATE_TOKEN PRIVATE_SERIAL')}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.equal(error.refusalCode,'printer-not-ready');assert.match(error.message,/not safely idle/);
    assert.doesNotMatch(JSON.stringify(error.diagnostics)+error.message,/PRIVATE_TOKEN|PRIVATE_SERIAL/);return true;
  });
});

test('late native safety completion cannot record dispatch or mark a print after deadline',async t=>{
  const events=await diagnosticHelper(t);const {withPrintDispatch,markPrintCommandSent,printOutcome}=await import('../dist/refusal.js');let release,entered,hooks=0;
  const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{entered=resolve});
  await withPrintDispatch(async()=>{
    const work=printWithBambuNative(options,undefined,{timeoutMs:5000,beforeDispatch:async()=>{entered();await gate},onDispatchAuthorized:()=>{hooks++;markPrintCommandSent()}});
    const checked=work.then(()=>{throw Error('unexpected success')},error=>{assert.equal(printOutcome(error),'not-sent');assert.equal(error.diagnostics.authorizationRequests,1)});
    await Promise.race([waiting,checked.then(()=>{throw Error('helper expired before the safety callback')})]);await checked;release();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(hooks,0);assert.equal((await events()).some(e=>e.kind==='dispatched'),false);
  });
});

test('expired helper waits for process exit but not a descendant holding its stdout pipe',async t=>{
  const directory=await trackedMkdtemp(path.join(os.tmpdir(),'native-pipe-')), executable=path.join(directory,'helper.mjs'),events=path.join(directory,'pid');
  await fs.writeFile(executable,`#!/usr/bin/env node
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),20000)'],{stdio:['ignore',process.stdout,process.stderr],detached:true});child.unref();
writeFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,descendant:child.pid}));
console.log('native_dispatch_request=1');setInterval(()=>{},1000);
`,{mode:0o755});
  const platform=Object.getOwnPropertyDescriptor(process,'platform'),previous=process.env.BAMBU_NATIVE_HELPER;Object.defineProperty(process,'platform',{value:'darwin'});process.env.BAMBU_NATIVE_HELPER=executable;
  let descendantPid;
  t.after(async()=>{if(descendantPid)try{process.kill(descendantPid,'SIGTERM')}catch{}Object.defineProperty(process,'platform',platform);if(previous===undefined)delete process.env.BAMBU_NATIVE_HELPER;else process.env.BAMBU_NATIVE_HELPER=previous;await fs.rm(directory,{recursive:true,force:true});});
  let entered;const waiting=new Promise(resolve=>{entered=resolve});
  const started=Date.now(),work=printWithBambuNative(options,undefined,{timeoutMs:5000,beforeDispatch:()=>{entered();return new Promise(()=>{})}});
  const rejected=assert.rejects(work,/timed out/);
  await Promise.race([waiting,rejected.then(()=>{throw Error('helper expired before the safety callback')})]);
  const {pid,descendant}=JSON.parse(await fs.readFile(events,'utf8'));descendantPid=descendant;
  await rejected;
  assert.ok(Date.now()-started<15000,'must not wait for descendant pipe holder');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.doesNotThrow(()=>process.kill(descendantPid,0),'descendant still holds the inherited pipe when the helper settles');
});


test('ordinary helper failure without an explicit rejection after authorization remains uncertain',async t=>{
  const events=await helper(t,{ordinaryExit:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain.*may.*accepted.*before retrying/i);
    assert.equal(error.diagnostics.authorizedAttempts,1);return true;
  });
  assert.equal((await events()).filter(event=>event.kind==='dispatched').length,1);
});


test('zero exit without a print receipt after authorization remains uncertain',async t=>{
  const events=await helper(t,{silentSuccess:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain.*without.*receipt/i);assert.equal(error.diagnostics.authorizedAttempts,1);return true;
  });assert.equal((await events()).filter(e=>e.kind==='dispatched').length,1);
});
test('explicit failed attempt followed by one successful receipt is accepted',async t=>{
  const events=await helper(t,{extraReceipt:true});const result=await printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}});
  assert.equal(result.status,'success');assert.equal((await events()).filter(e=>e.kind==='dispatched').length,1);
});


test('a success-looking receipt with arbitrary suffix is not accepted',async t=>{
  const events=await helper(t,{malformedReceipt:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain.*without.*receipt/i);assert.equal(error.diagnostics.authorizedAttempts,1);return true;
  });assert.equal((await events()).filter(e=>e.kind==='dispatched').length,1);
});


test('conflicting success and rejection receipts remain uncertain',async t=>{
  const events=await helper(t,{conflictingReceipts:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain.*may.*accepted.*before retrying/i);return true;
  });assert.equal((await events()).filter(e=>e.kind==='dispatched').length,1);
});


test('earlier negative receipt cannot classify later authorized exit without a receipt',async t=>{
  const events=await helper(t,{attempts:2,firstReceipt:'negative',ordinaryExit:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain/i);assert.equal(error.diagnostics.authorizedAttempts,2);return true;
  });assert.equal((await events()).filter(e=>e.kind==='dispatched').length,2);
});
test('earlier success receipt cannot authorize later attempt with no receipt',async t=>{
  const events=await helper(t,{attempts:2,firstReceipt:'success',silentSuccess:true});
  await assert.rejects(printWithBambuNative(options,undefined,{beforeDispatch:async()=>{}}),error=>{
    assert.equal(error.name,'NativeOperationError');assert.match(error.message,/uncertain.*receipt/i);assert.equal(error.diagnostics.authorizedAttempts,2);return true;
  });assert.equal((await events()).filter(e=>e.kind==='dispatched').length,2);
});
