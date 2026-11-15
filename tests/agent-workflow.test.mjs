import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { trackedMkdtempSync } from "./support/temp.mjs";
import { AGENT_WORKFLOW_URI, AGENT_WORKFLOW_TEXT, getAgentGuideResource, getAgentReadiness } from "../dist/agent-workflow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("readiness is a pure, conservative local summary", () => {
  const result = getAgentReadiness({ printerHostConfigured: true, printerModelConfigured: false, nativePrintAvailable: true });
  assert.equal(result.dispatch_authorized, false);
  assert.equal(result.physical_readiness_checked, false);
  assert.deepEqual(result.blockers.map(({code, state}) => [code, state]), [
    ["printer_serial", "unknown"], ["printer_token", "unknown"], ["printer_model", "missing"],
  ]);
  assert.equal(result.capabilities.native_print, "available");
  assert.equal(result.signed_controls.selected, "unknown");
  const blocked = getAgentReadiness({signedControlsSelected: true, signedConfigurationValid: false});
  assert.equal(blocked.signed_controls.configuration, "missing");
  assert.ok(blocked.blockers.some(({code}) => code === "signed_configuration"));
  assert.equal(result.capabilities.signed_mqtt, "unknown");
  assert.match(AGENT_WORKFLOW_TEXT, /--min-save.*SLICED.*does not resolve incomplete profiles/);
  const setup = getAgentGuideResource("bambu://workflow/setup");
  const signing = getAgentGuideResource("bambu://workflow/signing");
  assert.match(setup, /preserve the person’s cloud and Bambu Handy preference/);
  assert.match(setup, /LAN Only disconnects cloud/);
  assert.match(signing, /do not switch to LAN Only automatically/);
  assert.match(signing, /account session is not the application PEM signing bundle/);
  assert.match(signing, /Signing does not upload files/);
  const slicing = getAgentGuideResource("bambu://workflow/slicing");
  assert.match(slicing, /MCP profile resolver/);
  assert.match(slicing, /recursively resolve inheritance and includes/);
  assert.match(slicing, /Neither exposes a complete materialized machine\/process\/filament provenance receipt/);
  assert.match(slicing, /variant\/extruder relations/);
  assert.match(slicing, /start\/end, layer, AMS change and timelapse macro/);
  assert.match(slicing, /independent full provenance or macro audit/);
  assert.match(slicing, /cannot currently be established through these MCP tools/);
  assert.match(slicing, /Rely on these checks within their documented scope/);
  assert.match(slicing, /--min-save is an export-format option, not a profile-resolution repair/);
  const controls = getAgentGuideResource("bambu://workflow/controls");
  for (const method of ["bridge.handshake", "net.is_user_login", "net.get_user_id", "net.get_user_name", "net.get_user_avatar", "net.get_user_nickanme"]) assert.ok(controls.includes(method));
  assert.match(controls, /Raw bridge mutations are refused/);
  assert.match(controls, /Selected signed mode does not permit a raw bypass/);
  assert.match(AGENT_WORKFLOW_TEXT, /never automatically fall back/);
  assert.match(AGENT_WORKFLOW_TEXT, /signing does not upload/);
});

test("MCP exposes workflow and successful structured blocked readiness without secrets", async t => {
  const directory = trackedMkdtempSync(path.join(os.tmpdir(), "agent-workflow-"));
  const sentinel = "TEST_SECRET_DO_NOT_RETURN_283746";
  const env = { ...process.env, MCP_TRANSPORT: "stdio", HOME: directory, PRINTER_HOST: "", BAMBU_PRINTER_HOST: "", BAMBU_MODEL: "", BAMBU_PRINTER_MODEL: "", BAMBU_SERIAL: "", BAMBU_PRINTER_SERIAL: "", BAMBU_TOKEN: sentinel, BAMBU_PRINTER_ACCESS_TOKEN: "" };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist/index.js")], cwd: directory, env, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "agent-workflow-test", version: "1" });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.match(client.getInstructions() ?? "", /bambu:\/\/workflow\/index/);
  // A tools-only client can navigate the full index without listing or reading resources.
  const listed = await client.listTools();
  const guideTool = listed.tools.find(({name}) => name === "get_agent_guide");
  assert.ok(guideTool?.outputSchema);
  assert.equal(guideTool.annotations.readOnlyHint, true);
  const index = await client.callTool({name: "get_agent_guide", arguments: {}});
  assert.equal(index.structuredContent.topic, "index");
  assert.ok(index.structuredContent.available_topics.includes("printing"));
  for (const topic of index.structuredContent.available_topics) {
    const response = await client.callTool({name: "get_agent_guide", arguments: {topic}});
    assert.notEqual(response.isError, true);
    assert.equal(response.structuredContent.topic, topic);
    const expected = topic === "printing" ? AGENT_WORKFLOW_TEXT : getAgentGuideResource(`bambu://workflow/${topic}`);
    assert.equal(response.structuredContent.text, expected);
    assert.ok(!JSON.stringify(response).includes(sentinel));
  }
  const signingGuide = await client.callTool({name: "get_agent_guide", arguments: {topic: "signing"}});
  const signingFields = signingGuide.structuredContent.configuration_fields;
  const expectedSigningEnv = ["BAMBU_SIGNED_CONTROLS", "BAMBU_SIGNED_WRITE_TRANSPORT", "BAMBU_SIGNING_DIR", "BAMBU_SIGNING_DEVICE_CA_FILE", "BAMBU_SIGNING_STATE_DIR", "BAMBU_SIGNED_LOCAL_TLS_CA_FILE", "BAMBU_SIGNED_LOCAL_TLS_SERVERNAME", "BAMBU_SIGNED_CLOUD_BROKER", "BAMBU_SIGNED_CLOUD_USERNAME", "BAMBU_SIGNED_CLOUD_TOKEN", "BAMBU_SIGNED_CLOUD_AUTH"];
  assert.deepEqual(signingFields.map(field => field.env).sort(), expectedSigningEnv.sort());
  assert.equal(signingFields.find(field => field.env === "BAMBU_SIGNED_CLOUD_TOKEN").input, "secret");
  assert.match(signingGuide.structuredContent.text, /bambu-printer-mcp-signing-setup --repair/);
  assert.match(signingGuide.structuredContent.text, /Reservations coordinate only processes sharing that directory/);
  assert.match(signingGuide.structuredContent.text, /not a fallback after signing fails/);
  const setupGuide = await client.callTool({name: "get_agent_guide", arguments: {topic: "setup"}});
  assert.match(setupGuide.structuredContent.text, /counterpart_setup_fields/);
  assert.ok(listed.tools.find(({name}) => name === "counterpart_setup_fields")?.inputSchema);
  const resources = (await client.listResources()).resources;
  const guides = ["index", "setup", "account", "signing", "status", "camera", "design", "slicing", "dispatch", "controls"];
  const guideTexts = [];
  for (const guide of guides) {
    const uri = `bambu://workflow/${guide}`;
    assert.ok(resources.some(resource => resource.uri === uri), uri);
    const result = await client.readResource({ uri });
    assert.equal(result.contents[0].mimeType, "text/plain");
    guideTexts.push(result.contents[0].text);
  }
  const guidance = guideTexts.join("\n") + AGENT_WORKFLOW_TEXT;
  for (const {name} of listed.tools) assert.ok(guidance.includes(name), `No task guide mentions ${name}`);
  const account = await client.callTool({ name: "account_status", arguments: {} });
  assert.notEqual(account.isError, true);
  const accountStatus = account.structuredContent ?? JSON.parse(account.content[0].text);
  assert.equal(accountStatus.state, "not_configured");
  assert.equal(accountStatus.liveValidated, false);
  const accountTools = Object.fromEntries(listed.tools.filter(tool => tool.name.startsWith("account_")).map(tool => [tool.name, tool]));
  assert.equal(accountTools.account_status.annotations.readOnlyHint, true);
  assert.equal(accountTools.account_list_printers.annotations.openWorldHint, true);
  assert.equal(accountTools.account_login.annotations.readOnlyHint, false);
  assert.equal(accountTools.account_logout.annotations.destructiveHint, true);
  const fields = await client.callTool({ name: "counterpart_setup_fields", arguments: {} });
  assert.notEqual(fields.isError, true);
  assert.ok(fields.structuredContent);
  const info = await client.callTool({ name: "get_stl_info", arguments: { file_path: "/does-not-exist-agent-test.stl" } });
  assert.equal(info.isError, true);
  assert.ok((await client.listResources()).resources.some(({uri}) => uri === AGENT_WORKFLOW_URI));
  assert.deepEqual((await client.readResource({ uri: AGENT_WORKFLOW_URI })).contents, [{uri: AGENT_WORKFLOW_URI, mimeType: "text/plain", text: AGENT_WORKFLOW_TEXT}]);
  const tool = (await client.listTools()).tools.find(({name}) => name === "get_agent_readiness");
  assert.ok(tool?.outputSchema);
  assert.equal(tool.annotations.readOnlyHint, true);
  const response = await client.callTool({ name: "get_agent_readiness", arguments: {} });
  assert.notEqual(response.isError, true);
  assert.equal(response.structuredContent.dispatch_authorized, false);
  assert.equal(response.structuredContent.physical_readiness_checked, false);
  assert.ok(response.structuredContent.blockers.some(({code}) => code === "printer_model"));
  assert.ok(response.structuredContent.blockers.every(({code, next_action}) => code && next_action));
  assert.ok(!JSON.stringify(response).includes(sentinel));
});
