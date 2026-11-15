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
  for (const args of [{}, {fresh: false}]) assert.deepEqual((await client.callTool({name: "get_printer_status", arguments: args})).structuredContent, displayed);
  const result = await client.callTool({name: "get_printer_status", arguments: {fresh: true}});
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
