import test from 'node:test';
import assert from 'node:assert/strict';
import { readFilamentLibrary, matchFilamentLibrary } from '../dist/filament-library.js';

const tag = 'ABCDEF0123456789ABCDEF0123456789';
const entry = id => ({ id, filamentId: 'GFA00', RFID: tag, filamentType: 'PLA', netWeight: 0, totalNetWeight: null });

test('reads every page, separates reel and preset IDs, preserves nullable weights', async () => {
  const calls = [];
  const data = await readFilamentLibrary(async path => {
    calls.push(path);
    return calls.length === 1 ? { total: 21, hits: Array.from({ length: 20 }, (_, i) => entry(i + 1)) }
      : { total: 21, hits: [{ ...entry('9007199254740993'), RFID: '00000000000000000000000000000000', netWeight: null }] };
  });
  assert.equal(data.retrieval_complete, true); assert.equal(data.spools.length, 21);
  assert.match(calls[1], /offset=20&limit=20$/);
  assert.equal(data.spools[0].net_weight_g, 0); assert.equal(data.spools[0].total_net_weight_g, null);
  assert.equal(data.spools[20].id, '9007199254740993'); assert.equal(data.spools[20].rfid, null);
  assert.equal(data.spools[20].filament_id, 'GFA00'); assert.equal(data.spools[20].net_weight_g, null);
});

test('rejects unsafe IDs, duplicate pages and changed totals', async () => {
  await assert.rejects(readFilamentLibrary(async () => ({total: 1, hits: [entry(9007199254740992)]})), /incomplete or invalid/);
  assert.equal((await readFilamentLibrary(async () => ({hits: []}))).retrieval_mode, 'single_catalogue_response');
  await assert.rejects(readFilamentLibrary(async () => ({total: 21, hits: Array.from({length: 20}, (_, i) => entry(i))})), /incomplete or invalid/);
  let n = 0;
  await assert.rejects(readFilamentLibrary(async () => ++n === 1 ? {total: 21, hits: Array.from({length: 20}, (_, i) => entry(i))} : {total: 22, hits: [entry(20)]}), /incomplete or invalid/);
});

test('aborts deadline without a partial snapshot', async () => {
  let signal;
  await assert.rejects(readFilamentLibrary(async (_path, value) => { signal = value; return new Promise(() => {}); }, 10), /timed out/);
  assert.equal(signal.aborted, true);
});

test('joins only unique tray UUID to cloud RFID; no tag UID or fuzzy inference', async () => {
  const inventory = await readFilamentLibrary(async () => ({total: 1, hits: [entry(1)]}));
  const match = trays => matchFilamentLibrary(inventory.spools, trays);
  assert.deepEqual(match([{tray_uuid: tag.toLowerCase()}]), [{status:'matched',spool_id:'1'}]);
  assert.deepEqual(match([{tag_uid: tag}, {tray_uuid:'00000000000000000000000000000000'}]), [{status:'unlinked',spool_id:null},{status:'unlinked',spool_id:null}]);
  assert.deepEqual(match([{tray_uuid:tag},{tray_uuid:tag}]), [{status:'ambiguous',spool_id:null},{status:'ambiguous',spool_id:null}]);
  assert.deepEqual(matchFilamentLibrary([...inventory.spools, {...inventory.spools[0], id:'2'}], [{tray_uuid:tag}]), [{status:'ambiguous',spool_id:null}]);
});


test('retains account reported location separately without making an identity match', async () => {
  const inventory = await readFilamentLibrary(async () => ({total:1,hits:[{id:1,RFID:null,inPrinter:true,devId:'printer',amsSn:'ams',amsId:0,amsType:1,slotId:'2',deviceName:'Device'}]}));
  assert.deepEqual(inventory.spools[0].reported_location, {source:'account_report',freshness:'not_guaranteed',in_printer:true,device_id:'printer',ams_serial:'ams',ams_id:0,ams_type:1,slot_id:'2',device_name:'Device'});
  assert.deepEqual(matchFilamentLibrary(inventory.spools, [{tray_uuid:null}]), [{status:'unlinked',spool_id:null}]);
});


test('total-free responses are one bounded catalogue, even above requested limit', async () => {
  for (const count of [15, 25]) {
    let calls = 0;
    const result = await readFilamentLibrary(async () => { calls++; return {hits:Array.from({length:count},(_,i)=>entry(i))}; });
    assert.equal(calls,1); assert.equal(result.spools.length,count);
    assert.equal(result.retrieval_mode,'single_catalogue_response'); assert.equal(result.reported_total,null);
  }
  await assert.rejects(readFilamentLibrary(async () => ({hits:Array.from({length:2001},(_,i)=>entry(i))})), /incomplete or invalid/);
  await assert.rejects(readFilamentLibrary(async () => ({hits:[entry(1),entry(1)]})), /incomplete or invalid/);
});

test('rejects a total disappearing during pagination', async () => {
  let calls=0;
  await assert.rejects(readFilamentLibrary(async () => ++calls===1 ? {total:21,hits:Array.from({length:20},(_,i)=>entry(i))} : {hits:[entry(20)]}), /incomplete or invalid/);
});

test('unified inventory preserves every library record, uncertain slots and separate quantities', async () => {
  const {unifyFilamentInventory} = await import('../dist/filament-library.js');
  const uuid = n => n.toString(16).padStart(32,'0');
  const records = Array.from({length:15},(_,i)=>({id:i+1,RFID:uuid(i+1),filamentId:'GFA00',filamentType:'PLA',netWeight:i===0?0:null,totalNetWeight:1000,
    ...(i===0 ? {inPrinter:false} : i===4 ? {inPrinter:false} : i===5 ? {inPrinter:true,deviceName:'Other'} : {})}));
  const library = await readFilamentLibrary(async () => ({hits:records}));
  const tray = (id,key,extra={}) => ({tray_uuid:key,loaded:true,occupancy:'reported_loaded',source:'ams',ams_id:0,tray_id:id,slot:id,label:`A${id+1}`,tray_info_idx:'GFA00',tray_type:'PLA',tray_sub_brands:null,tray_color:'FFFFFFFF',remain_percent:50,remaining_weight_g:null,...extra});
  const slots = [0,1,2,3].map(i=>tray(i,uuid(i+1)));
  slots.push(tray(4,null,{source:'external',label:'External'}),tray(5,uuid(99),{tray_sub_brands:'PLA-S'}));
  const result=unifyFilamentInventory(library,slots);
  assert.equal(result.coverage.library_records,15); assert.equal(result.spools.length,15);
  assert.equal(result.spools.filter(s=>s.load_state==='loaded').length,5);
  assert.equal(result.spools[0].conflict,'account_reports_not_loaded');
  assert.equal(result.spools[0].quantities.account.net_weight_g,0);
  assert.equal(result.spools[1].quantities.account.net_weight_g,null);
  assert.equal(result.spools[0].quantities.printer.remaining_percent,50);
  assert.equal(result.spools[4].load_state,'not_loaded');
  assert.equal(result.spools[4].location.source,'account_report');
  assert.equal(result.spools[5].load_state,'loaded');
  assert.equal(result.spools[5].load_state_evidence,'account_report');
  assert.equal(result.spools[6].load_state,'unknown');
  assert.equal(result.unidentified_loaded_slots.length,1);
  assert.equal(result.coverage.unmatched_printer_spool_observations,1);
  assert.equal(result.unmatched_printer_spool_observations[0].may_overlap_library_records,true);
  assert.equal(result.unmatched_printer_spool_observations[0].brand,null);
  assert.equal(result.unmatched_printer_spool_observations[0].name,'PLA-S');
  assert.equal(result.unmatched_printer_spool_observations[0].name_source,'tray_sub_brands');
  assert.equal(result.coverage.unique_physical_count,null);
});

test('unified inventory keeps duplicate identities ambiguous and marks missing library coverage', async () => {
  const {unifyFilamentInventory} = await import('../dist/filament-library.js');
  const uuid='1234567890ABCDEF1234567890ABCDEF';
  const library = await readFilamentLibrary(async()=>({hits:[{id:1,RFID:uuid,inPrinter:false},{id:2,RFID:uuid,inPrinter:true}]}));
  const slot={tray_uuid:uuid,loaded:true,source:'ams',ams_id:0,tray_id:0,slot:0,label:'A1',tray_info_idx:null,tray_type:'PLA',tray_sub_brands:null,tray_color:null,remain_percent:null};
  const ambiguous=unifyFilamentInventory(library,[slot]);
  assert.deepEqual(ambiguous.spools.map(s=>s.load_state),['unknown','unknown']);
  assert.equal(ambiguous.unidentified_loaded_slots.length,1);
  const noLibrary=unifyFilamentInventory(null,[slot,{...slot,tray_uuid:null,slot:1}]);
  assert.equal(noLibrary.spools.length,0); assert.equal(noLibrary.unmatched_printer_spool_observations[0].identity.source,'printer_uuid');
  assert.equal(noLibrary.coverage.library_records,null); assert.equal(noLibrary.coverage.unmatched_printer_spool_observations,1);
  assert.equal(noLibrary.unidentified_loaded_slots.length,1);
});
