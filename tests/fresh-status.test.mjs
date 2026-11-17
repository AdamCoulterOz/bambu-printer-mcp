import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BambuImplementation } from "../dist/printers/bambu.js";
import { readFreshPrinterStatus } from "../dist/safety/printer-state.js";
import { getAgentGuideResource } from "../dist/agent-workflow.js";
import { trackedMkdtempSync } from "./support/temp.mjs";

const serial = "20PTESTFRESH";
const state = {command: "push_status", model_id: "N6", gcode_state: "FINISH", print_error: 0, hms: [], mc_percent: 100};
function rawPrinter() {
  const printer = new EventEmitter();
  const commands = [];
  printer.data = {...state, serial, model: "X2D"};
  printer.publish = async payload => {
    commands.push(payload);
    if (payload.pushing) printer.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify({print: state})));
  };
  const report = message => printer.emit("rawMessage", `device/${serial}/report`, Buffer.from(JSON.stringify(message)));
  return {printer, report, commands};
}
const ota = value => ({info: {command: "get_version", module: [{name: "ota", sn: value}]}});
const settle = () => new Promise(resolve => setImmediate(resolve));

test("explicit fresh identity waits for a returned serial after a model-only X2D report", async () => {
  const {printer, report, commands} = rawPrinter();
  let resolved = false;
  const pending = readFreshPrinterStatus(printer, serial, 1000, {requireObservedSerial: true}).then(value => { resolved = true; return value; });
  await settle();
  assert.equal(resolved, false, "N6 plus configured/cached serial cannot satisfy an explicit fresh identity read");
  report(ota(serial));
  const result = await pending;
  assert.equal(result.model, "x2d"); assert.equal(result.observedSerial, serial); assert.equal(result.serial, serial);
  assert.equal(result.observation.source, "mqtt");
  assert.ok(result.observation.receivedAt >= result.observation.requestedAt);
  assert.ok(result.observation.receivedAt <= Date.now());
  assert.deepEqual(commands.map(value => value.pushing?.command ?? value.info?.command), ["pushall", "get_version"]);
  assert.equal(printer.listenerCount("rawMessage"), 0);
});

test("default internal safety read still accepts a freshly reported model without requiring a returned serial", async () => {
  const {printer} = rawPrinter();
  const result = await readFreshPrinterStatus(printer, serial, 100);
  assert.equal(result.model, "x2d"); assert.equal(result.observedSerial, undefined);
});

test("explicit fresh identity rejects mismatched serials and times out without cached or configured substitution", async () => {
  const first = rawPrinter();
  const mismatch = readFreshPrinterStatus(first.printer, serial, 100, {requireObservedSerial: true});
  first.report(ota("20POTHER"));
  await assert.rejects(mismatch, /returned serial does not match/i);
  assert.equal(first.printer.listenerCount("rawMessage"), 0);
  const absent = rawPrinter();
  // A valid version event predating this request and printer.data both remain insufficient.
  absent.report(ota(serial));
  await assert.rejects(readFreshPrinterStatus(absent.printer, serial, 20, {requireObservedSerial: true}), /fresh|timed out/i);
  assert.equal(absent.printer.listenerCount("rawMessage"), 0);
});

test("BambuImplementation passes the explicit identity requirement to the collector using its existing client", async () => {
  const {printer, report} = rawPrinter();
  const backend = new BambuImplementation();
  let connections = 0;
  backend.getPrinter = async () => { connections++; return printer; };
  let resolved = false;
  const pending = backend.getSafetyStatus("synthetic.invalid", serial, "TEST", {requireObservedSerial: true}).then(value => { resolved = true; return value; });
  await settle(); assert.equal(resolved, false); report(ota(serial));
  assert.equal((await pending).observedSerial, serial); assert.equal(connections, 1);
});

test("MCP fresh status is additive, strictly boolean, read-only and delegates to the one existing backend", async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "mcp-fresh-status-test-"));
  const previousCwd = process.cwd(), previousEnv = {...process.env};
  process.chdir(directory);
  Object.assign(process.env, {BAMBU_PRINTER_HOST: "synthetic.invalid", BAMBU_PRINTER_SERIAL: serial, BAMBU_PRINTER_ACCESS_TOKEN: "TEST", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", CAD_ENABLED: "0", TEMP_DIR: directory});
  const {BambuPrinterMCPServer} = await import("../dist/index.js");
  const owner = new BambuPrinterMCPServer(), backend = owner.bambu, calls = [];
  const displayed = {connected: true, status: "FINISH", model: "Unknown", serial};
  const observed = {connected: true, status: "FINISH", model: "x2d", serial, observedSerial: serial, raw: state, observation: {source: "mqtt", requestedAt: 100, receivedAt: 101, identitySource: "module-serial"}};
  backend.getStatus = async (...args) => { calls.push(["display", ...args]); return displayed; };
  backend.getSafetyStatus = async (...args) => { calls.push(["fresh", ...args]); return observed; };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: "fresh-status-client", version: "1"});
  t.after(async () => {
    await client.close(); await owner.server.close(); process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv); fs.rmSync(directory, {recursive: true, force: true});
  });
  await owner.server.connect(serverTransport); await client.connect(clientTransport);
  const tool = (await client.listTools()).tools.find(value => value.name === "get_printer_status");
  assert.equal(tool.inputSchema.properties.fresh.type, "boolean");
  assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.openWorldHint, true);
  for (const args of [{detail: "full"}, {fresh: false, detail: "full"}]) assert.deepEqual((await client.callTool({name: "get_printer_status", arguments: args})).structuredContent, displayed);
  const result = await client.callTool({name: "get_printer_status", arguments: {fresh: true, detail: "full"}});
  assert.deepEqual(result.structuredContent, observed);
  assert.equal(owner.bambu, backend);
  assert.deepEqual(calls.map(value => value[0]), ["display", "display", "fresh"]);
  assert.deepEqual(calls[2].slice(1), ["synthetic.invalid", serial, "TEST", {requireObservedSerial: true}]);
  for (const flag of ["true", "false", 1, 0, null, [], {}]) {
    const invalid = await client.callTool({name: "get_printer_status", arguments: {fresh: flag}});
    assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /fresh must be a boolean/);
  }
  assert.equal(calls.length, 3, "malformed flags must not read either display or fresh backend");
  for (const message of ["Printer-returned serial does not match the configured printer serial.", "Timed out waiting for a fresh MQTT safety report."]) {
    backend.getSafetyStatus = async () => { throw new Error(message); };
    const refused = await client.callTool({name: "get_printer_status", arguments: {fresh: true}});
    assert.equal(refused.isError, true); assert.ok(refused.content[0].text.includes(message));
  }
  assert.equal(calls.length, 3, "fresh failures must never fall back to display status");
  assert.match(getAgentGuideResource("bambu://workflow/status"), /fresh:true/);
  assert.match(getAgentGuideResource("bambu://workflow/status"), /does not authorize dispatch/);
});

test('compact status defaults are bounded, source-aware and exclude private telemetry', async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), 'mcp-compact-status-'));
  const previousCwd = process.cwd(), previousEnv = {...process.env};
  process.chdir(directory);
  Object.assign(process.env, {BAMBU_PRINTER_HOST:'synthetic.invalid', BAMBU_PRINTER_SERIAL:serial, BAMBU_PRINTER_ACCESS_TOKEN:'TEST', BAMBU_MODEL:'', BAMBU_PRINTER_MODEL:'', CAD_ENABLED:'0', TEMP_DIR:directory});
  const {BambuPrinterMCPServer} = await import('../dist/index.js');
  const owner = new BambuPrinterMCPServer();
  const raw = {gcode_state:'RUNNING', mc_percent:48, mc_remaining_time:73, layer_num:120, total_layer_num:250,
    nozzle_temper:201, nozzle_target_temper:220, bed_temper:60, bed_target_temper:60,
    print_error:0, hms:[{attr:1, code:2}], secret_token:'SENTINEL_SECRET', ipcam:{url:'https://private.invalid/stream'},
    ams:{ams:[{id:'0',tray:[{id:'1',tray_type:'PLA',tray_color:'FFFFFFFF',remain:42,tag_uid:'PRIVATE_TAG'}]}]},
    vir_slot:[{id:'254',tray_type:'PETG',tray_color:'112233FF'}], padding:'x'.repeat(25000)};
  const display={connected:true,status:'RUNNING',model:'X2D',serial,raw,ams:raw.ams};
  const fresh={...display, observedSerial:serial, observation:{source:'mqtt',requestedAt:100,receivedAt:101,identitySource:'module-serial'}};
  let displayCalls=0, freshCalls=0;
  owner.bambu.getStatus=async()=>{displayCalls++;return display};
  owner.bambu.getSafetyStatus=async()=>{freshCalls++;return fresh};
  const [clientTransport, serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'compact-status-test',version:'1'});
  t.after(async()=>{await client.close();await owner.server.close();process.chdir(previousCwd); for(const key of Object.keys(process.env)) if(!(key in previousEnv)) delete process.env[key];Object.assign(process.env,previousEnv);fs.rmSync(directory,{recursive:true,force:true});});
  await owner.server.connect(serverTransport);await client.connect(clientTransport);
  const tool=(await client.listTools()).tools.find(x=>x.name==='get_printer_status');
  assert.deepEqual(tool.inputSchema.properties.detail.enum,['compact','full']);
  const full=await client.callTool({name:'get_printer_status',arguments:{detail:'full'}});
  assert.deepEqual(full.structuredContent,display);
  const defaultDisplay=await client.callTool({name:'get_printer_status',arguments:{}});
  const compact=await client.callTool({name:'get_printer_status',arguments:{detail:'compact'}});
  assert.equal(compact.structuredContent,undefined);
  const value=JSON.parse(compact.content[0].text);
  assert.deepEqual(defaultDisplay,compact);
  assert.equal(value.freshness,'not_guaranteed');assert.equal(value.observation,null);
  assert.deepEqual(value.progress,{percent:48,remaining_minutes:73,layer:120,total_layers:250});
  assert.equal(value.slots.length,2);assert.equal(value.slots[0].remaining_percent,42);
  assert.deepEqual(value.errors,{print_error:0,hms:['0000000100000002'],hms_truncated:false});
  assert.equal(value.temperatures.nozzle.actual,201);assert.equal(value.temperatures.bed.target,60);
  assert.doesNotMatch(JSON.stringify(compact),/SENTINEL_SECRET|private\.invalid|PRIVATE_TAG|x{100}/);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(display).length / 10);
  assert.equal(value.detail,'compact');
  const verified=await client.callTool({name:'get_printer_status',arguments:{fresh:true,detail:'compact'}});
  const freshValue=JSON.parse(verified.content[0].text);
  const defaultFresh=await client.callTool({name:'get_printer_status',arguments:{fresh:true}});
  assert.deepEqual(defaultFresh,verified);
  assert.equal(freshValue.freshness,'fresh_mqtt');
  assert.equal(freshValue.observation.identity_verified,true);
  assert.equal(freshValue.observation.identity_source,'module-serial');
  assert.doesNotMatch(JSON.stringify(verified),new RegExp(serial));
  const invalid=await client.callTool({name:'get_printer_status',arguments:{detail:'short'}});
  assert.equal(invalid.isError,true);assert.equal(displayCalls,3);assert.equal(freshCalls,2);
  owner.runtimeConfig.enableJsonResponse=false;
  const textOnly=await client.callTool({name:'get_printer_status',arguments:{detail:'compact'}});
  assert.equal(textOnly.structuredContent,undefined);assert.equal(JSON.parse(textOnly.content[0].text).progress.percent,48);
});

test('compact view never invents fresh evidence, temperatures or empty errors from sparse reports', async () => {
  const {compactPrinterStatus}=await import('../dist/printers/compact-status.js');
  const sparse=compactPrinterStatus({connected:true,status:'UNKNOWN',model:'X2D',observation:{source:'mqtt'}},true);
  assert.equal(sparse.freshness,'not_guaranteed');assert.equal(sparse.observation,null);
  assert.equal(sparse.progress.percent,null);assert.equal(sparse.temperatures.nozzle.actual,null);
  assert.equal(sparse.errors.hms,null);assert.equal(sparse.errors.print_error,null);
  const packed=compactPrinterStatus({connected:true,status:'RUNNING',raw:{device:{extruder:{state:16,info:[{id:1,temp:(220*65536)+195}]},ctc:{info:{temp:(50*65536)+38}}}}},false);
  assert.deepEqual(packed.temperatures.nozzle,{actual:195,target:220});assert.equal(packed.temperatures.chamber,38);
  const dual=compactPrinterStatus({connected:true,status:'RUNNING',model:'X2D',raw:{device:{extruder:{state:0,info:[{id:0,temp:220*65536+200},{id:1,temp:210*65536+190}]}}}},false);
  assert.deepEqual(dual.temperatures.nozzles,[{index:0,position:'right',actual:200,target:220},{index:1,position:'left',actual:190,target:210}]);
  assert.equal(compactPrinterStatus({connected:false,status:'error'},false).state,'ERROR');
});
