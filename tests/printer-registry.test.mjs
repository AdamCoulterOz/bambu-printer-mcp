import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyPrinterSelection, describePrinters, loadPrinterRegistry, PrinterSelectionError, withPrinterChoice } from "../dist/printers/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = ["a1", "a1mini", "x2d", "p1s"];
const DEFAULTS = { host: "10.0.0.2", serial: "20PTEST", token: "x2d-code", model: "x2d" };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "printer-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registry(t) {
  const dir = tempDir(t);
  const codeFile = path.join(dir, "a1-code");
  fs.writeFileSync(codeFile, "a1-code\n");
  const env = { BAMBU_PRINTERS: JSON.stringify([{ name: "A1", serial: "039test", host: "10.0.0.3", model: "A1", access_code_file: codeFile }]) };
  return loadPrinterRegistry(env, DEFAULTS, MODELS);
}

test("the env printer stays the default and extra printers load from JSON", t => {
  const printers = registry(t);
  assert.deepEqual(printers.map(p => [p.name, p.serial, p.model, p.isDefault]), [["X2D", "20PTEST", "x2d", true], ["A1", "039TEST", "a1", false]]);
  assert.equal(printers[1].token, "a1-code");
  const listed = describePrinters(printers);
  assert.equal(JSON.stringify(listed).includes("a1-code"), false, "access codes are never listed");
  assert.equal(listed[1].access_code_configured, true);
});

test("a {printers: [...]} file and an access code from an environment variable", t => {
  const dir = tempDir(t);
  const file = path.join(dir, "printers.json");
  fs.writeFileSync(file, JSON.stringify({ printers: [{ name: "Mini", serial: "030X", host: "h", model: "a1mini", access_code_env: "MINI_CODE", connection_mode: "lan_mqtt_ftps" }] }));
  const printers = loadPrinterRegistry({ BAMBU_PRINTERS_FILE: file, MINI_CODE: "m" }, { host: "", serial: "", token: "", model: "" }, MODELS);
  assert.deepEqual(printers.map(p => [p.name, p.token, p.connectionMode]), [["Mini", "m", "lan_mqtt_ftps"]]);
});

test("bad printer lists are refused", () => {
  const load = list => loadPrinterRegistry({ BAMBU_PRINTERS: JSON.stringify(list) }, DEFAULTS, MODELS);
  assert.throws(() => load([{ name: "A1", serial: "039", host: "h" }]), /needs name, serial, host and model/);
  assert.throws(() => load([{ name: "A1", serial: "039", host: "h", model: "ender3" }]), /unsupported model/);
  assert.throws(() => load([{ name: "x2d", serial: "039", host: "h", model: "a1" }]), /named/);
  assert.throws(() => load([{ name: "Other", serial: "20ptest", host: "h", model: "x2d" }]), /configured twice/);
  assert.throws(() => load([{ name: "A1", serial: "039", host: "h", model: "a1", access_code: "plain" }]), /not in the printer list/);
  assert.throws(() => loadPrinterRegistry({ BAMBU_PRINTERS: "{" }, DEFAULTS, MODELS), /not valid JSON/);
});

test("printer by name or serial fills that printer's routing", t => {
  const printers = registry(t);
  for (const printer of ["A1", "a1", "039TEST"]) {
    const args = applyPrinterSelection({ printer, detail: "full" }, printers);
    assert.deepEqual(args, { detail: "full", bambu_serial: "039TEST", host: "10.0.0.3", bambu_token: "a1-code", bambu_model: "a1", connection_mode: "lan_mqtt_ftps", dev_id: "039TEST" });
  }
  // Explicit values win; the default printer keeps the server-wide route.
  assert.equal(applyPrinterSelection({ printer: "A1", host: "override" }, printers).host, "override");
  assert.equal(applyPrinterSelection({ printer: "A1", connection_mode: "signed_mqtt" }, printers).connection_mode, "signed_mqtt");
  assert.deepEqual(applyPrinterSelection({ printer: "X2D" }, printers), { bambu_serial: "20PTEST", host: "10.0.0.2", bambu_token: "x2d-code", bambu_model: "x2d" });
});

test("only routing arguments the tool declares are filled", t => {
  const printers = registry(t);
  assert.deepEqual(applyPrinterSelection({ printer: "A1", file_path: "/x.3mf" }, printers, new Set(["file_path", "bambu_model"])), { file_path: "/x.3mf", bambu_model: "a1" });
  // Conflicts are still refused even when the tool does not take the conflicting argument's partner.
  assert.throws(() => applyPrinterSelection({ printer: "A1", bambu_model: "x2d" }, printers, new Set(["bambu_model"])), /does not match/);
});

test("a registered serial alone selects that printer; other calls are unchanged", t => {
  const printers = registry(t);
  assert.equal(applyPrinterSelection({ bambu_serial: "039test" }, printers).host, "10.0.0.3");
  const untouched = { bambu_serial: "20PTEST" };
  assert.equal(applyPrinterSelection(untouched, printers), untouched);
  const other = { bambu_serial: "UNKNOWN", host: "h" };
  assert.equal(applyPrinterSelection(other, printers), other);
  assert.equal(applyPrinterSelection(undefined, printers), undefined);
});

test("unknown or conflicting choices are refused", t => {
  const printers = registry(t);
  assert.throws(() => applyPrinterSelection({ printer: "P1S" }, printers), err => err instanceof PrinterSelectionError && /Configured printers: X2D, A1/.test(err.message));
  assert.throws(() => applyPrinterSelection({ printer: "A1", bambu_serial: "20PTEST" }, printers), /does not match printer A1/);
  assert.throws(() => applyPrinterSelection({ printer: "A1", bambu_model: "x2d" }, printers), /does not match printer A1/);
  assert.throws(() => applyPrinterSelection({ printer: "" }, printers), /configured printer name or serial/);
});

test("printer choice is added only to tools that target a printer or model", () => {
  const withSerial = withPrinterChoice({ name: "a", inputSchema: { type: "object", properties: { bambu_serial: {} } } });
  const withModel = withPrinterChoice({ name: "b", inputSchema: { type: "object", properties: { bambu_model: {} } } });
  const plain = { name: "c", inputSchema: { type: "object", properties: { path: {} } } };
  assert.ok(withSerial.inputSchema.properties.printer);
  assert.ok(withModel.inputSchema.properties.printer);
  assert.equal(withPrinterChoice(plain), plain);
});

test("the server lists configured printers and refuses an unknown printer", async t => {
  const dir = tempDir(t);
  const file = path.join(dir, "printers.json");
  fs.writeFileSync(path.join(dir, "code"), "dummy");
  fs.writeFileSync(file, JSON.stringify([{ name: "A1", serial: "039TEST", host: "127.0.0.1", model: "a1", access_code_file: path.join(dir, "code") }]));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "pipe", cwd: dir,
    env: { ...process.env, MCP_TRANSPORT: "stdio", BAMBU_PRINTERS_FILE: file, BAMBU_PRINTERS: "", BAMBU_PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_SERIAL: "20PTEST", BAMBU_SERIAL: "", BAMBU_PRINTER_ACCESS_TOKEN: "dummy", BAMBU_PRINTER_MODEL: "x2d", BAMBU_MODEL: "", BAMBU_PRINTER_NAME: "Big" },
  });
  const client = new Client({ name: "printer-registry-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  assert.ok(byName.get_printer_status.inputSchema.properties.printer);
  assert.ok(byName.print_3mf.inputSchema.properties.printer);
  assert.equal(byName.account_status.inputSchema.properties.printer, undefined);
  const listed = await client.callTool({ name: "list_configured_printers", arguments: {} });
  const body = JSON.parse(listed.content[0].text);
  assert.deepEqual(body.printers.map(p => [p.name, p.model, p.default]), [["Big", "x2d", true], ["A1", "a1", false]]);
  assert.equal(listed.content[0].text.includes("dummy"), false);
  // A file-only tool receives just the selected model, not connection arguments it refuses.
  const inspected = await client.callTool({ name: "inspect_print_file", arguments: { printer: "A1", file_path: path.join(dir, "missing.3mf") } });
  assert.equal(inspected.isError, true);
  assert.doesNotMatch(JSON.stringify(inspected.content), /accepts only/);
  const refused = await client.callTool({ name: "get_printer_status", arguments: { printer: "Nope" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Unknown printer "Nope". Configured printers: Big, A1/);
});
