import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPageRequest, projectHistoryPage } from '../dist/account/history.js';
import { AccountManager } from '../dist/account/index.js';

test('printer history pages carry offset and never expose URL fields', () => {
  const first = historyPageRequest('device123', {offset: 3, limit: 2});
  assert.equal(first.path, '/v1/user-service/my/tasks?offset=3&limit=2&deviceId=device123');
  const page = projectHistoryPage({total: 7, hits: [{id: 4, deviceId: 'device123', title: 'Part', cover: 'https://secret.invalid/token'}, {id: 5, deviceId: 'device123'}]}, 'device123', 3, 2);
  assert.deepEqual(page, {tasks: [{id:4, title:'Part'}, {id:5}], offset:3, limit:2, printer_reported_total:7, next_offset:5});
  assert.equal(projectHistoryPage({total: 1, hits: [{id:1,deviceId:'device123'}]}, 'device123', 0, 2).next_offset, null);
});

test('rate-limited page fails explicitly and is not cached or retried', async () => {
  const env = {BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883', BAMBU_SIGNED_CLOUD_USERNAME:'u_123', BAMBU_SIGNED_CLOUD_TOKEN:'token'};
  const manager = new AccountManager({vendor:{request:async () => ({devices:[{dev_id:'device123'}]})}});
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('', {status:429}); };
    await assert.rejects(manager.cloudPrintHistoryPage('device123', {}, env), /HTTP 429/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('page read checks account binding and sends the filtered request', async () => {
  const env = {BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883', BAMBU_SIGNED_CLOUD_USERNAME:'u_123', BAMBU_SIGNED_CLOUD_TOKEN:'token'};
  const manager = new AccountManager({vendor:{request:async (_region, path) => {
    assert.equal(path, '/v1/iot-service/api/user/bind');
    return {devices:[{dev_id:'device123'}]};
  }}});
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      assert.match(url, /^https:\/\/api\.bambulab\.com\/v1\/user-service\/my\/tasks\?offset=[01]&limit=1&deviceId=device123$/);
      assert.equal(opts.method, 'GET');
      const id = url.includes('offset=0') ? 1 : 2;
      return new Response(JSON.stringify({total:2,hits:[{id,deviceId:'device123'}]}));
    };
    const [page, duplicate] = await Promise.all([manager.cloudPrintHistoryPage('device123', {limit:1}, env), manager.cloudPrintHistoryPage('device123', {limit:1}, env)]);
    assert.equal(page.next_offset, 1);
    assert.equal(page.printer_reported_total, 2);
    assert.deepEqual(duplicate.tasks, page.tasks);
    assert.equal(page.cached,false);assert.equal(duplicate.cached,true);
    assert.equal(calls, 1);
    assert.equal((await manager.cloudPrintHistoryPage('device123', {offset:1,limit:1}, env)).next_offset, null);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('history rejects malformed pages, mismatched printers and unbounded requests', () => {
  assert.throws(() => historyPageRequest('device123', {limit:101}));
  assert.throws(() => historyPageRequest('device123', {offset:-1}));
  assert.throws(() => projectHistoryPage({total:1,hits:[{id:1,deviceId:'other'}]}, 'device123', 0, 1));
  assert.throws(() => projectHistoryPage({total:2,hits:[]}, 'device123', 0, 1));
  assert.throws(() => projectHistoryPage({total:0,hits:[{deviceId:'device123'}]}, 'device123', 0, 1));
  assert.throws(() => projectHistoryPage({total:1,hits:[{deviceId:'device123'}]}, 'device123', 0, 1));
  assert.equal(projectHistoryPage({total:1,hits:[]}, 'device123', 5, 1).next_offset,null);
});

test('large numeric task IDs remain exact decimal strings', async () => {
  const env = {BAMBU_SIGNED_CLOUD_BROKER:'mqtts://us.mqtt.bambulab.com:8883', BAMBU_SIGNED_CLOUD_USERNAME:'u_123', BAMBU_SIGNED_CLOUD_TOKEN:'token'};
  const manager=new AccountManager({vendor:{request:async()=>({devices:[{dev_id:'device123'}]})}});
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('{"total":1,"hits":[{"id":9007199254740993,"deviceId":"device123"}]}');
    const result=await manager.cloudPrintHistoryPage('device123',{},env);
    assert.equal(result.tasks[0].id,'9007199254740993');
  } finally {globalThis.fetch=original;}
});
