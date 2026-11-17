import {trackedMkdtemp} from './support/temp.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const printerModule = new URL("../dist/printers/bambu.js", import.meta.url).href;

const ONE_TRAY = { connected: true, model: "P2S", status: "IDLE",
  ams: { tray_now: "255", ams: [{ id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FFFFFFFF", remain: -1 }] }] } };

async function inventoryFixture(t, { binary, profiles, slicerType = "bambustudio", override = false, missing = false, invalidDirectory = false, status = ONE_TRAY, colourCodes, tool = "get_printer_filaments", args = {}, library }) {
  const root = await trackedMkdtemp(path.join(os.tmpdir(), "bambu-filament-inventory-"));
  const client = new Client({ name: "filament-inventory-test", version: "1" });
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, binary);
  const profilesRoot = path.join(root, profiles);
  const filamentDir = path.join(profilesRoot, "BBL", "filament");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture executable; must never be launched");
  await fs.mkdir(path.join(profilesRoot, "BBL", "machine"), { recursive: true });
  await fs.mkdir(filamentDir, { recursive: true });
  if (colourCodes) await fs.writeFile(path.join(filamentDir, "filaments_color_codes.json"), JSON.stringify({ data: colourCodes }));
  await fs.writeFile(path.join(filamentDir, "Generic PLA @base.json"), JSON.stringify({ name: "Generic PLA @base", filament_id: "GFL99" }));
  const expectedProfile = path.join(filamentDir, "Generic PLA @BBL P2S.json");
  await fs.writeFile(expectedProfile, JSON.stringify({ name: "Generic PLA @BBL P2S", inherits: "Generic PLA @base" }));
  if (invalidDirectory) {
    await fs.rm(filamentDir, { recursive: true });
    await fs.writeFile(filamentDir, "not a profile directory");
  }
  const preload = `
    import { BambuImplementation } from ${JSON.stringify(printerModule)};
    BambuImplementation.prototype.getStatus = async () => (${JSON.stringify(status)});
    ${library === undefined ? '' : `
      const { AccountManager } = await import(${JSON.stringify(new URL("../dist/account/index.js", import.meta.url).href)});
      AccountManager.prototype.listFilamentInventory = async () => ${library === 'error' ? `Promise.reject(new Error('private upstream error'))` : `(${JSON.stringify(library)})`};
    `}
  `;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`, serverEntry],
    cwd: root,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      PRINTER_HOST: "127.0.0.1", BAMBU_PRINTER_HOST: "127.0.0.1",
      BAMBU_SERIAL: "TEST_SERIAL", BAMBU_PRINTER_SERIAL: "TEST_SERIAL",
      BAMBU_TOKEN: "TEST_TOKEN", BAMBU_PRINTER_ACCESS_TOKEN: "TEST_TOKEN",
      BAMBU_MODEL: "p2s", BAMBU_PRINTER_MODEL: "p2s",
      SLICER_TYPE: slicerType, SLICER_PATH: executable, BAMBU_STUDIO_PATH: "",
      BAMBU_PROFILES_ROOT: missing ? path.join(root, "missing-profiles") : override ? profilesRoot : "",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  const result = await client.callTool({ name: tool, arguments: args });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  return { inventory: JSON.parse(result.content[0].text), expectedProfile };
}

for (const [name, options] of [
  ["Windows installation", { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles" }],
  ["macOS bundle", { binary: "BambuStudio.app/Contents/MacOS/BambuStudio", profiles: "BambuStudio.app/Contents/Resources/profiles" }],
  ["Linux installation", { binary: "prefix/bin/bambu-studio", profiles: "prefix/share/BambuStudio/profiles" }],
  ["selected Orca installation", { binary: "OrcaSlicer/OrcaSlicer.exe", profiles: "OrcaSlicer/resources/profiles", slicerType: "orcaslicer" }],
  ["explicit profile root", { binary: "selected/bambu-studio.exe", profiles: "custom profiles", override: true }],
]) {
  test(`filament inventory resolves profiles from the ${name}`, async t => {
    const { inventory, expectedProfile } = await inventoryFixture(t, options);
    assert.equal(inventory.summary.loaded_slots, 1);
    assert.equal(inventory.summary.resolved_profile_slots, 1);
    assert.equal(await fs.realpath(inventory.trays[0].resolved_profile_path), await fs.realpath(expectedProfile));
    assert.equal(inventory.trays[0].profile_resolution, "model");
    assert.equal(inventory.trays[0].tray_color, "FFFFFFFF");
    assert.equal(inventory.recommended.load_filaments, inventory.trays[0].resolved_profile_path);
  });
}

test("filament inventory does not borrow profiles when its explicit root is missing", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", missing: true,
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
  assert.equal(inventory.recommended, null);
});

test("filament inventory remains available when slicer configuration is invalid", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", slicerType: "invalid-slicer",
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
});

test("filament inventory remains available when the profile directory cannot be read", async t => {
  const { inventory } = await inventoryFixture(t, {
    binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", invalidDirectory: true,
  });
  assert.equal(inventory.summary.loaded_slots, 1);
  assert.equal(inventory.summary.resolved_profile_slots, 0);
  assert.equal(inventory.trays[0].resolved_profile_path, null);
  assert.equal(inventory.recommended, null);
});

test("counterpart_propose_filaments reads the live AMS once: Studio's colour names, tray labels, and an AMS-HT as print_3mf numbers it", async t => {
  const status = { connected: true, model: "P2S", status: "IDLE", ams: { ams: [
    { id: "0", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "000000FF" }, { id: "1", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FEC600FF" }] },
    { id: "128", tray: [{ id: "0", state: 11, tray_info_idx: "GFL99", tray_type: "PLA", tray_color: "FFFFFFFF" }] }] } };
  const colourCodes = [{ fila_id: "GFL99", fila_color: ["#FEC600FF"], fila_color_name: { en: "Sunflower Yellow" } }, { fila_id: "GFL99", fila_color: ["#FFFFFFFF"], fila_color_name: { en: "Jade White" } },
    { fila_id: "GFA05", fila_color: ["#FFFFFFFF"], fila_color_name: { en: "White" } }];
  const { inventory: proposal } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status, colourCodes,
    tool: "counterpart_propose_filaments", args: { filaments: [{ index: 1, colour: "#000000", material: "PLA" }, { index: 2, colour: "#FFFFFF", material: "PLA" }] } });
  assert.deepEqual(proposal.trays.map(tray => [tray.slot, tray.label, tray.name]),
    [[0, "A1", "PLA"], [1, "A2", "Sunflower Yellow PLA"], [128, "AMS HT A", "Jade White PLA"]], "128, never 512: print_3mf takes the AMS-HT unit id");
  assert.deepEqual(proposal.mapping, [{ index: 1, slot: 0 }, { index: 2, slot: 128 }]);
  assert.ok(proposal.trays.every(tray => tray.profile), "each spool carries the profile slice_stl takes");
});

test("inventory reports AMS HT and both external holders without conflating rolls", async t => {
  const status = { connected: false, model: "X2D", raw: { ams: { tray_now: "255", ams: [
    { id: "1", tray: [{ id: "2", tray_type: "PLA", tag_uid: "AABB", tray_uuid: "0123456789abcdef0123456789abcdef", tray_info_idx: "GFL99", tray_color: "FFFFFFFF", remain: 0, tray_weight: "1000", remain_g: 0 }] },
    { id: "128", tray: [{ id: "0", tray_type: "PLA", tag_uid: "CCDD", tray_uuid: "fedcba9876543210fedcba9876543210", tray_info_idx: "GFL99", tray_color: "FFFFFFFF", remain: 101, tray_weight: -1, remain_g: "invalid" }] },
  ] }, vir_slot: [{ id: "255", tray_type: "PETG" }, { id: "254", tray_type: "PLA" }] } };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status, args: { bambu_model: "x2d" } });
  assert.deepEqual(inventory.trays.map(x => x.slot), [6, 128, 255, 254]);
  assert.deepEqual(inventory.trays.map(x => x.source), ["ams", "ams", "external", "external"]);
  assert.deepEqual(inventory.trays.slice(2).map(x => x.physical_extruder), [{ index: 0, position: "right", role: "main" }, { index: 1, position: "left", role: "deputy" }]);
  assert.deepEqual(inventory.trays.slice(0, 2).map(x => x.tray_uuid), ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"]);
  assert.equal(inventory.trays[0].remain_percent, 0);
  assert.equal(inventory.trays[0].remaining_weight_g, 0);
  assert.equal(inventory.trays[0].nominal_weight_g, 1000);
  assert.equal(inventory.trays[1].remain_percent, null);
  assert.equal(inventory.trays[1].nominal_weight_g, null);
  assert.equal(inventory.trays[1].remaining_weight_g, null);
  assert.equal(inventory.trays[0].weight_provenance.remaining, "remain_g");
  assert.equal(inventory.summary.loaded_slots, 4);
  assert.equal(inventory.current_source, null);
});

test("legacy external holder is one report and absent data remains unknown", async t => {
  const status = { connected: false, model: "P2S", raw: { ams: { tray_now: "254", ams: [
    { id: "0", tray: [{ id: "0", tag_uid: "00000000", remain: -1 }, { id: "1" }, { id: "2", tray_type: "PLA" }] },
    { id: "1", tray: [{ id: "0" }] },
  ] }, vt_tray: { id: "254", tray_type: "TPU", tray_weight: "1000" } } };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status });
  assert.deepEqual(inventory.trays.map(x => x.occupancy), ["unknown", "unknown", "reported_loaded", "unknown", "reported_loaded"]);
  assert.equal(inventory.summary.empty_slots, 0);
  assert.equal(inventory.summary.unknown_slots, 3);
  assert.equal(inventory.current_source, "external");
  assert.equal(inventory.trays.at(-1).physical_extruder, null);
  assert.equal(inventory.trays.at(-1).remaining_weight_g, null);
  assert.equal(inventory.trays[0].tag_uid, null);
});

test("dual external holders are retained when one is active and legacy metadata is also present", async t => {
  const status = { connected: false, model: "X2D", raw: { ams: { tray_now: "254" }, vt_tray: { id: "254", tray_type: "PLA" }, vir_slot: [{ id: 255, tray_type: "PLA" }, { id: 254, tray_type: "PETG" }] } };
  const { inventory } = await inventoryFixture(t, { binary: "Bambu Studio/bambu-studio.exe", profiles: "Bambu Studio/resources/profiles", status, args: { bambu_model: "x2d" } });
  assert.deepEqual(inventory.trays.map(x => x.slot), [255, 254]);
  assert.equal(inventory.current_source, "external");
});


test("aggregate inventory preserves printer slots on cloud error and never reveals error details", async t => {
  const {inventory} = await inventoryFixture(t, {binary:'bin/studio', profiles:'share/profiles', tool:'get_filament_inventory', library:'error'});
  assert.equal(inventory.printer.trays.length, 1);
  assert.equal(inventory.printer.observation.freshness, 'not_guaranteed');
  assert.equal(inventory.library.status, 'unavailable');
  assert.equal(inventory.matches, null);
  assert.equal(inventory.coverage.library_records, null);
  assert.equal(inventory.unidentified_loaded_slots.length, 1);
  assert.doesNotMatch(JSON.stringify(inventory), /private upstream error/);
});

test("aggregate inventory matches unique tray UUID only and retains all cloud records", async t => {
  const uuid = '1234567890ABCDEF1234567890ABCDEF';
  const status = {connected:true, model:'P2S', raw:{ams:{ams:[{id:'0',tray:[{id:'0',state:11,tray_info_idx:'GFL99',tray_type:'PLA',tray_uuid:uuid}]}]}}};
  const library = {source:'bambu_account_cloud', fetched_at:'2026-01-01T00:00:00.000Z', retrieval_complete:true, retrieval_mode:'single_catalogue_response', reported_total:null, consistency:'not_guaranteed', spools:[{id:'10',rfid:uuid},{id:'11',rfid:null}]};
  const {inventory} = await inventoryFixture(t, {binary:'bin/studio', profiles:'share/profiles', tool:'get_filament_inventory', status, library});
  assert.equal(inventory.library.spools.length, 2);
  assert.equal(inventory.spools.length, 2);
  assert.equal(inventory.spools[0].load_state, 'loaded');
  assert.equal(inventory.spools[1].load_state, 'unknown');
  assert.deepEqual(inventory.matches, [{status:'matched',spool_id:'10'}]);
});

test("aggregate inventory can omit account access", async t => {
  const {inventory} = await inventoryFixture(t, {binary:'bin/studio', profiles:'share/profiles', tool:'get_filament_inventory', args:{include_library:false}, library:'error'});
  assert.equal(inventory.library.status, 'not_requested');
});

test('MCP cancellation aborts the account page and does not request the next page', async t => {
  const root = await trackedMkdtemp(path.join(os.tmpdir(), 'bambu-filament-cancel-'));
  const marker = path.join(root, 'calls');
  const accountModule = new URL('../dist/account/index.js', import.meta.url).href;
  const preload = `
    import { appendFileSync } from 'node:fs';
    import { AccountManager } from ${JSON.stringify(accountModule)};
    const original = AccountManager.prototype.listFilamentInventory;
    AccountManager.prototype.listFilamentInventory = function(env, signal) {
      this.vendor = {request: async (_region, _path, _body, _token, requestSignal) => {
        appendFileSync(${JSON.stringify(marker)}, 'page\\n');
        await new Promise(resolve => requestSignal.addEventListener('abort', resolve, {once:true}));
        appendFileSync(${JSON.stringify(marker)}, 'aborted\\n');
        return {total:21,hits:Array.from({length:20},(_,i)=>({id:i}))};
      }};
      return original.call(this, env, signal);
    };`;
  const client = new Client({name:'filament-cancel-test', version:'1'});
  t.after(async () => { await client.close(); await fs.rm(root, {recursive:true,force:true}); });
  const transport = new StdioClientTransport({command:process.execPath, args:['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,serverEntry], cwd:root,
    env:{...process.env,MCP_TRANSPORT:'stdio',BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883',BAMBU_SIGNED_CLOUD_USERNAME:'u_123',BAMBU_SIGNED_CLOUD_TOKEN:'fixture-token'}, stderr:'pipe'});
  await client.connect(transport);
  const controller = new AbortController();
  const request = client.callTool({name:'account_list_filament_inventory',arguments:{}}, undefined, {signal:controller.signal});
  const rejected = assert.rejects(request);
  for (let i=0;i<100;i++) { try { await fs.access(marker); break; } catch { await new Promise(r => setTimeout(r,10)); } }
  assert.match(await fs.readFile(marker,'utf8'), /page/);
  controller.abort(); await rejected;
  for (let i=0;i<100;i++) { if ((await fs.readFile(marker,'utf8')).includes('aborted')) break; await new Promise(r => setTimeout(r,10)); }
  assert.equal(await fs.readFile(marker,'utf8'), 'page\naborted\n');
});
