import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, privateDecrypt, verify } from 'node:crypto';
import { encodeSignedPrint } from '../dist/signing/wire.js';

const app = generateKeyPairSync('rsa', { modulusLength: 2048 });
const device = generateKeyPairSync('rsa', { modulusLength: 2048 });
function decodeBlocks(ciphertext) {
  const bytes = Buffer.from(ciphertext, 'base64');
  const out = [];
  for (let i = 0; i < bytes.length; i += 256) {
    const block = privateDecrypt({ key: device.privateKey, padding: constants.RSA_NO_PADDING }, bytes.subarray(i, i + 256));
    assert.equal(block[0], 0); assert.equal(block[1], 2);
    const separator = block.indexOf(0, 2);
    assert.ok(separator >= 10);
    out.push(block.subarray(separator + 1));
  }
  return Buffer.concat(out).toString('utf8');
}
test('signs the exact transmitted UTF-8 payload after multi-block field encryption', () => {
  const plaintext = 'G1 X10 ; 測試🚀\n'.repeat(30);
  const result = encodeSignedPrint({ command: 'gcode_line', sequence_id: '20001', param: plaintext }, 'abcCN=Test', app.privateKey, device.publicKey);
  const text = result.toString('utf8');
  const parsed = JSON.parse(text);
  const payload = Buffer.from('{' + text.slice(text.indexOf(',"print"') + 1));
  assert.equal(parsed.header.payload_len, payload.length);
  assert.equal(verify('sha256', payload, app.publicKey, Buffer.from(parsed.header.sign_string, 'base64')), true);
  assert.equal(parsed.print.param, undefined);
  assert.equal(decodeBlocks(parsed.print.param_enc), plaintext);
});
test('encrypts project URL only and preserves structured fields', () => {
  const wire = encodeSignedPrint({ command: 'project_file', sequence_id: '20002', param: 'Metadata/plate_1.gcode', subtask_name: '測試🚀', url: 'file:///測試.3mf', ams_mapping: [0, 1] }, 'abcCN=Test', app.privateKey, device.publicKey).toString('utf8');
  const parsed = JSON.parse(wire);
  const payload = Buffer.from('{' + wire.slice(wire.indexOf(',"print"') + 1));
  assert.equal(parsed.header.payload_len, payload.length);
  assert.equal(verify('sha256', payload, app.publicKey, Buffer.from(parsed.header.sign_string, 'base64')), true);
  assert.equal(parsed.print.url, undefined);
  assert.equal(decodeBlocks(parsed.print.url_enc), 'file:///測試.3mf');
  assert.equal(parsed.print.param, 'Metadata/plate_1.gcode');
  assert.equal(parsed.print.subtask_name, '測試🚀');
  assert.deepEqual(parsed.print.ams_mapping, [0, 1]);
});
test('rejects unknown commands and unexpected fields', () => {
  assert.throws(() => encodeSignedPrint({ command: 'arbitrary', sequence_id: '1' }, 'id', app.privateKey, device.publicKey));
  assert.throws(() => encodeSignedPrint({ command: 'stop', sequence_id: '1', extra: 'x' }, 'id', app.privateKey, device.publicKey));
});
test('signs the existing typed AMS drying addresses including AMS HT without broadening other addresses', () => {
  for (const ams_id of [0, 1, 2, 3, 128]) {
    for (const param of ['start_drying', 'stop_drying']) {
      const wire = encodeSignedPrint({ command: 'ams_control', sequence_id: '20003', ams_id, param }, 'cert', app.privateKey, device.publicKey).toString('utf8');
      const result = JSON.parse(wire);
      const payload = Buffer.from('{' + wire.slice(wire.indexOf(',"print"') + 1));
      assert.equal(result.print.ams_id, ams_id);
      assert.equal(result.print.param, param);
      assert.equal(result.header.payload_len, payload.length);
      assert.equal(verify('sha256', payload, app.publicKey, Buffer.from(result.header.sign_string, 'base64')), true);
    }
  }
  for (const ams_id of [-1, 4, 127, 129, 255, 1.5, '1', '128']) assert.throws(() => encodeSignedPrint({ command: 'ams_control', sequence_id: '20004', ams_id, param: 'start_drying' }, 'cert', app.privateKey, device.publicKey));
  for (const ams_id of [0, 128]) assert.throws(() => encodeSignedPrint({ command: 'ams_control', sequence_id: '20004', ams_id, param: 'arbitrary' }, 'cert', app.privateKey, device.publicKey));
});

test('signed project accepts only bounded physical nozzle mappings', () => {
  const make = nozzle_mapping => encodeSignedPrint({command:'project_file', sequence_id:'1', url:'brtc://emmc/model.3mf', nozzle_mapping}, 'cert', app.privateKey, device.publicKey);
  assert.deepEqual(JSON.parse(make([1,0]).toString()).print.nozzle_mapping, [1,0]);
  for (const invalid of [[], [-1], [2], [0.5], ['1'], Array(65).fill(0)]) assert.throws(() => make(invalid), /nozzle mapping/);
});
