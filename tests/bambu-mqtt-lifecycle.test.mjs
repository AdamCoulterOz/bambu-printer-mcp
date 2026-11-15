import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Module mocks are confined to this child; the normal suite needs no flags or
// transport injection in production. No real MQTT implementation is loaded.
test("MQTT lifecycle settles deadlines, owns one attempt and isolates retired clients", {timeout: 30_000}, () => {
  const source = String.raw`
import assert from "node:assert/strict";
import {mock} from "node:test";
import {EventEmitter} from "node:events";
const created = [], behaviors = [], passed = [], unhandled = [];
process.on("unhandledRejection", error => unhandled.push(error));
mock.module("mqtt", {namedExports: {connect: (_url, options) => {
  const behavior = behaviors.shift() ?? {}, client = new EventEmitter();
  client.options = options; client.ends = []; client.subscriptions = []; client.published = []; client.destroyed = 0;
  client.stream = {destroy: () => {client.destroyed++;}};
  client.subscribe = (topic, callback) => {client.subscriptions.push(topic); callback?.();};
  client.publish = (...args) => {client.published.push(args); behavior.publish?.(client, args); const callback = args.at(-1); if (typeof callback === "function") callback();};
  client.end = (...args) => {client.ends.push(args[0] === true); const callback = args.at(-1); if (!behavior.hungEnd && typeof callback === "function") callback();};
  created.push(client); return client;
}}});
const {BambuImplementation, PrinterMqttConnectionError} = await import(MODULE_URL);
const {withOperationSignal} = await import(OPERATION_URL);
mock.timers.enable({apis:["setTimeout"]});
const serial = "20PSYNTHETIC", host = "synthetic.invalid", token = "SYNTHETIC";
const key = (value = serial) => host + "-" + value + "-" + token;
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = promise => promise.then(value => ({value}), error => ({error}));
const emit = (client, print) => client.emit("message", "device/" + serial + "/report", Buffer.from(JSON.stringify(print)));
function telemetry(client, args) {
  const command = JSON.parse(args[1]);
  if (command.pushing) emit(client, {print:{command:"push_status",gcode_state:"FINISH",model_id:"N6",print_error:0,hms:[]}});
  if (command.info) emit(client, {info:{command:"get_version",module:[{name:"ota",sn:serial}]}});
}
for (const event of ["close", "offline", "disconnect"]) {
  const backend = new BambuImplementation(), start = created.length;
  const one = result(backend.getSafetyStatus(host, serial, token)), two = result(backend.getSafetyStatus(host, serial, token));
  await flush(); assert.equal(created.length - start, 1, "parallel waiters share one initial MQTT attempt");
  const client = created.at(-1);
  assert.equal(client.options.connectTimeout, 10000); assert.equal(client.options.reconnectPeriod, 1000); assert.equal(client.options.keepalive, 20);
  client.emit(event);
  const outcomes = await Promise.all([one, two]);
  for (const outcome of outcomes) {
    assert.match(outcome.error?.message ?? "", /closed|offline|disconnected/i);
    assert.ok(outcome.error instanceof PrinterMqttConnectionError);
    assert.equal(outcome.error.diagnostics.phase, "connect"); assert.equal(outcome.error.diagnostics.reason, event); assert.equal(outcome.error.diagnostics.connectTimeoutMs, 10000);
  }
  assert.equal(outcomes[0].error, outcomes[1].error, "connection failure is shared before caller-specific stage annotation");
  const firstStage = outcomes[0].error.withSafetyStage("initial_safety"), secondStage = outcomes[1].error.withSafetyStage("confirmation_safety");
  assert.notEqual(firstStage, secondStage); assert.equal(firstStage.safetyStage, "initial_safety"); assert.equal(secondStage.safetyStage, "confirmation_safety"); assert.equal(outcomes[0].error.safetyStage, undefined);
  assert.notEqual(firstStage.diagnostics, secondStage.diagnostics); assert.ok(Object.isFrozen(firstStage.diagnostics));
  await flush(); assert.ok(client.ends.includes(true)); assert.equal(backend.printerStore.initialConnectionPromises.size, 0); assert.equal(backend.printerStore.clients.size, 0);
  await backend.disconnectAll(); passed.push("quiet-" + event);
}
{
  const backend = new BambuImplementation(); let settled = false;
  const pending = result(backend.getSafetyStatus(host, serial, token)).then(value => {settled = true; return value;});
  await flush(); const client = created.at(-1), owned = backend.printerStore.clients.get(key());
  mock.timers.tick(9999); await flush(); assert.equal(settled, false);
  mock.timers.tick(1); const outcome = await pending; assert.match(outcome.error?.message ?? "", /connection timed out/i);
  assert.equal(outcome.error.diagnostics.phase, "connect"); assert.equal(outcome.error.diagnostics.reason, "timeout");
  await flush(); assert.ok(client.ends.includes(true));
  client.emit("connect"); owned.emit("client:connect"); owned.emit("rawMessage", "device/" + serial + "/report", Buffer.from(JSON.stringify({print:{gcode_state:"RUNNING"}})));
  await flush(); assert.equal(backend.printerStore.printers.size, 0); assert.equal(backend.printerStore.getCachedReport(host, serial, token), null); assert.equal(client.published.length, 0);
  await backend.disconnectAll(); passed.push("silent-deadline-and-late-connect");
}
{
  const backend = new BambuImplementation(); let release;
  const gate = new Promise(resolve => {release = resolve;});
  const pending = result(backend.printerStore.getPrinter(host, serial, token)); await flush();
  const client = created.at(-1), owned = backend.printerStore.clients.get(key()); owned.onConnect = () => gate;
  client.emit("connect"); await flush(); mock.timers.tick(10000);
  const outcome = await pending; assert.match(outcome.error?.message ?? "", /timed out/i);
  assert.equal(outcome.error.diagnostics.phase, "subscribe"); assert.equal(outcome.error.diagnostics.reason, "timeout"); release(); await flush();
  assert.equal(backend.printerStore.printers.size, 0); await backend.disconnectAll(); passed.push("subscription-deadline");
}
{
  const backend = new BambuImplementation(), store = backend.printerStore;
  const first = store.getPrinter(host, serial, token); await flush(); const old = created.at(-1); old.emit("connect"); const oldPrinter = await first;
  emit(old, {print:{command:"push_status",gcode_state:"RUNNING",mc_percent:10}}); await flush(); assert.equal(store.getCachedReport(host, serial, token).mc_percent, 10);
  old.emit("offline"); await flush();
  behaviors.push({publish: telemetry});
  const next = store.getPrinter(host, serial, token); await flush(); const current = created.at(-1); current.emit("connect"); const currentPrinter = await next;
  emit(current, {print:{command:"push_status",gcode_state:"FINISH",mc_percent:100}}); await flush();
  oldPrinter.emit("client:error", new Error("stale")); oldPrinter.emit("client:disconnect", true); oldPrinter.emit("client:connect");
  oldPrinter.emit("rawMessage", "device/" + serial + "/report", Buffer.from(JSON.stringify({print:{gcode_state:"RUNNING",mc_percent:99}})));
  oldPrinter.emit("printer:dataUpdate", {gcode_state:"RUNNING"}, {gcode_state:"RUNNING",mc_percent:99});
  assert.equal(store.printers.get(key()), currentPrinter); assert.equal(store.getCachedReport(host, serial, token).mc_percent, 100);
  const fresh = await backend.getSafetyStatus(host, serial, token, {requireObservedSerial:true}); assert.equal(fresh.observedSerial, serial); assert.equal(fresh.model, "x2d");
  await backend.disconnectAll(); passed.push("replacement-and-stale-events");
}
{
  const backend = new BambuImplementation(), store = backend.printerStore, start = created.length;
  behaviors.push({hungEnd:true}, {hungEnd:true});
  const pending = result(store.getPrinter(host, serial, token)); const active = store.getPrinter(host, "20PACTIVE", token);
  await flush(); const pendingClient = created[start], activeClient = created[start + 1]; activeClient.emit("connect"); await active;
  let drained = false; const drain = backend.disconnectAll().then(() => {drained = true;});
  const replacement = store.getPrinter(host, serial, token); await flush();
  assert.match((await pending).error?.message ?? "", /cancelled|retired/i); assert.equal(created.length - start, 2); assert.equal(store.clients.size, 0);
  mock.timers.tick(4999); await flush(); assert.equal(drained, false);
  mock.timers.tick(1); await drain; await flush(); assert.equal(created.length - start, 3);
  assert.ok(pendingClient.ends.includes(true)); assert.ok(activeClient.ends.includes(true)); assert.ok(pendingClient.destroyed > 0); assert.ok(activeClient.destroyed > 0);
  const client = created.at(-1); client.emit("connect"); const printer = await replacement;
  pendingClient.emit("connect"); activeClient.emit("offline"); await flush(); assert.equal(store.printers.get(key()), printer);
  await backend.disconnectAll(); passed.push("bounded-pending-and-active-drain");
}
{
  const backend = new BambuImplementation(); let release; let latePublishes = 0;
  backend.getPrinter = () => new Promise(resolve => {release = resolve;});
  const pending = result(backend.getSafetyStatus(host, serial, token)); mock.timers.tick(15000);
  assert.match((await pending).error?.message ?? "", /timed out while connecting/i);
  const late = new EventEmitter(); late.publish = async () => {latePublishes++;}; release(late); await flush();
  assert.equal(latePublishes, 0); passed.push("end-to-end-deadline-no-late-collector");
}
{
  const backend = new BambuImplementation(); let release, elapsed = 0;
  const clock = mock.method(performance, "now", () => elapsed);
  backend.getPrinter = () => new Promise(resolve => {release = resolve;});
  const pending = result(backend.getSafetyStatus(host, serial, token));
  elapsed = 12000;
  const printer = new EventEmitter(); printer.publish = async () => {};
  release(printer); await flush(); mock.timers.tick(2999); await flush();
  let finished = false; pending.then(() => {finished = true;}); await flush(); assert.equal(finished, false);
  mock.timers.tick(1); assert.match((await pending).error?.message ?? "", /fresh MQTT safety report/i);
  clock.mock.restore(); passed.push("remaining-safety-budget");
}
{
  const backend = new BambuImplementation(), controller = new AbortController(), start = created.length;
  behaviors.push({publish:telemetry});
  const cancelled = result(withOperationSignal(controller.signal, () => backend.getSafetyStatus(host, serial, token, {requireObservedSerial:true})));
  const valid = backend.getSafetyStatus(host, serial, token, {requireObservedSerial:true});
  await flush(); controller.abort(); const client = created.at(-1); client.emit("connect");
  assert.ok((await cancelled).error); assert.equal((await valid).observedSerial, serial); assert.equal(created.length - start, 1); assert.equal(client.ends.length, 0);
  await backend.disconnectAll(); passed.push("cancelled-waiter-preserves-peer");
}
{
  for (const code of ["ECONNRESET", "SECRET_token_password"]){
    const backend = new BambuImplementation(); const pending = result(backend.getSafetyStatus(host, serial, token)); await flush();
    const original = Object.assign(new Error("SECRET host serial token password packet"), {code}); created.at(-1).emit("error", original);
    const error = (await pending).error; assert.equal(error.message, "Printer MQTT connection failed.");
    assert.equal(error.diagnostics.reason, "error"); assert.equal(error.diagnostics.transportCode, code === "ECONNRESET" ? code : undefined);
    assert.ok(!JSON.stringify(error).includes("SECRET")); assert.ok(!error.stack.includes("SECRET")); await backend.disconnectAll();
  }
  const input = {phase:"connect",reason:"error",elapsedMs:2,connectTimeoutMs:10000,transportCode:"SECRET",packet:"SECRET",host:"SECRET"};
  const safe = new PrinterMqttConnectionError(input); input.elapsedMs=999;
  assert.equal(safe.diagnostics.elapsedMs, 2); assert.ok(!JSON.stringify(safe).includes("SECRET"));
  passed.push("allowlisted-immutable-diagnostics");
}
await flush(); assert.deepEqual(unhandled, []); mock.restoreAll(); console.log(JSON.stringify({passed}));
`;
  const moduleUrl = new URL("../dist/printers/bambu.js", import.meta.url).href;
  const operationUrl = new URL("../dist/operation-context.js", import.meta.url).href;
  const stdout = execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module"], {
    input: source.replace("MODULE_URL", JSON.stringify(moduleUrl)).replace("OPERATION_URL", JSON.stringify(operationUrl)),
    encoding: "utf8", timeout: 25_000, stdio: ["pipe", "pipe", "pipe"],
  });
  const {passed} = JSON.parse(stdout.trim());
  assert.deepEqual(passed, ["quiet-close", "quiet-offline", "quiet-disconnect", "silent-deadline-and-late-connect", "subscription-deadline", "replacement-and-stale-events", "bounded-pending-and-active-drain", "end-to-end-deadline-no-late-collector", "remaining-safety-budget", "cancelled-waiter-preserves-peer", "allowlisted-immutable-diagnostics"]);
});

// Exercise the real MQTT packet/timeout machinery through a Duplex broker.
// No TCP/TLS socket, printer or vendor endpoint is created.
test("MQTT allows a 2.5-second CONNACK within its unchanged 10-second hard deadline", {timeout: 30_000}, () => {
  const source = String.raw`
import assert from "node:assert/strict";
import {mock} from "node:test";
import {Duplex} from "node:stream";
import {createRequire} from "node:module";
const real = await import("mqtt"), packets = createRequire(import.meta.url)("mqtt-packet");
const trials=[]; let legacy=false;
mock.module("mqtt",{namedExports:{connect:(_url,options)=>{
  assert.equal(options.connectTimeout,10000);
  const configured={...options,...(legacy?{connectTimeout:2000}:{})}, events=[], started=performance.now(); let timer;
  const parser=packets.parser();
  const stream=new Duplex({read(){},write(chunk,_encoding,done){parser.parse(chunk);done();},destroy(error,done){if(timer)clearTimeout(timer);done(error);}});
  parser.on("packet",packet=>{
    if(packet.cmd==="connect")timer=setTimeout(()=>{if(!stream.destroyed)stream.push(packets.generate({cmd:"connack",returnCode:0,sessionPresent:false}));},2500);
    if(packet.cmd==="subscribe")stream.push(packets.generate({cmd:"suback",messageId:packet.messageId,granted:[0]}));
    if(packet.cmd==="disconnect")queueMicrotask(()=>stream.destroy());
  });
  const client=new real.MqttClient(()=>stream,configured);
  for(const event of ["connect","offline","close","error"])client.on(event,error=>events.push({event,elapsedMs:Math.round(performance.now()-started),code:error?.message==="connack timeout"?"connack-timeout":undefined}));
  trials.push({events}); return client;
}}});
const {BambuImplementation,PrinterMqttConnectionError}=await import(MODULE_URL);
for(const previous of [true,false]){
  legacy=previous; const backend=new BambuImplementation(); let error;
  try{await backend.printerStore.getPrinter("in-memory.invalid","20PSYNTHETIC","SYNTHETIC");}catch(value){error=value;}
  if(previous){
    assert.ok(error instanceof PrinterMqttConnectionError); assert.equal(error.message,"Printer MQTT went offline."); assert.equal(error.diagnostics.phase,"connect"); assert.equal(error.diagnostics.reason,"offline");
    const events=trials.at(-1).events; assert.equal(events[0].event,"offline"); assert.equal(events[1].code,"connack-timeout");
  }else{assert.equal(error,undefined);assert.equal(trials.at(-1).events[0].event,"connect");}
  await backend.disconnectAll();
}
mock.restoreAll();console.log(JSON.stringify({legacyFailed:true,currentConnected:true,realMqtt:true,sockets:0}));
`;
  const stdout = execFileSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module"], {
    input: source.replace("MODULE_URL", JSON.stringify(new URL("../dist/printers/bambu.js", import.meta.url).href)),
    encoding: "utf8", timeout: 25_000, stdio: ["pipe", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(stdout.trim()), {legacyFailed: true, currentConnected: true, realMqtt: true, sockets: 0});
});
