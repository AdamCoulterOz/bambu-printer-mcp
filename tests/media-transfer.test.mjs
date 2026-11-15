import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifiedUploadInternal, MediaTransferError } from '../dist/printers/media-transfer.js';

const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const name = 'checked-60f770b6-3671-4e45-a31e-326eb2231629.gcode.3mf';
const serial = '20PTEST00000001';
const frame = (magic, payload, reserved = 0) => {
  const header = Buffer.alloc(16); header.writeUInt32LE(payload.length); header.writeUInt32LE(magic, 4);
  header.writeUInt32LE(reserved, 12);
  return Buffer.concat([header, payload]);
};

class FakeTls extends EventEmitter {
  authorized = true;
  destroyed = false;
  writes = [];
  constructor(peer) { super(); this.peer = peer; }
  setTimeout(ms) { this.idleMs = ms; }
  write(bytes, callback) {
    assert.equal(this.destroyed, false, 'no late write after cancellation/close');
    this.writes.push(Buffer.from(bytes));
    this.peer.receive(this, bytes);
    if (this.peer.holdWrites) this.peer.pendingWrites.push(callback);
    else queueMicrotask(() => callback());
    return false; // Exercise write completion/backpressure handling on every frame.
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  deliver(bytes) {
    if (this.destroyed) return;
    // Every header and payload cross read boundaries; no packet-size assumption.
    const widths = [1, 3, 11, 257, 8192];
    let offset = 0; let i = 0;
    while (offset < bytes.length && !this.destroyed) {
      const end = Math.min(bytes.length, offset + widths[i++ % widths.length]);
      this.emit('data', bytes.subarray(offset, end)); offset = end;
    }
  }
}

class Peer {
  commands = [];
  chunks = [];
  pendingWrites = [];
  constructor(bytes, overrides = {}) { this.bytes = bytes; Object.assign(this, overrides); }
  connect = options => {
    this.tlsOptions = options;
    this.socket = new FakeTls(this);
    queueMicrotask(() => this.socket.emit('secureConnect'));
    return this.socket;
  };
  send(socket, request, result, reply, binary) {
    const json = { mtype: request.mtype, sequence: request.sequence, ...(request.cmdtype === undefined ? {} : { cmdtype: request.cmdtype }), result, ...(reply === undefined ? {} : { reply }) };
    this.json?.(json, request);
    const payload = Buffer.from(JSON.stringify(json));
    socket.deliver(frame(0x0002013f, binary === undefined ? payload : Buffer.concat([payload, Buffer.from('\n\n'), binary]), this.controlReserved ?? 0));
  }
  receive(socket, bytes) {
    const magic = bytes.readUInt32LE(4); const payload = bytes.subarray(16);
    assert.equal(bytes.readUInt32LE(0), payload.length);
    assert.equal(bytes.readUInt32LE(12), 0);
    if (magic === 0x0101013f) {
      assert.equal(payload.length, 16); assert.equal(payload.subarray(0, 8).toString(), 'bblp\0\0\0\0');
      assert.equal(payload.subarray(8).toString(), 'TESTCODE');
      if (this.loginReply?.(socket) === false) return;
      const status = Buffer.alloc(4); status.writeUInt32LE(this.loginStatus ?? 0);
      socket.deliver(frame(0x0001013f, status, this.loginReserved ?? 0)); return;
    }
    assert.equal(magic, 0x0102013f);
    const separator = payload.indexOf('\n\n');
    const request = JSON.parse(payload.subarray(0, separator < 0 ? undefined : separator).toString());
    const binary = separator < 0 ? undefined : payload.subarray(separator + 2);
    this.commands.push(request);
    if (this.before?.(socket, request, binary) === false) return;
    if (request.mtype === 12291) {
      assert.equal(request.sequence, 0); assert.deepEqual({ ...request.req, pid: undefined }, { t_av: 1, mtype: 12289, peer_t: 3, pid: undefined, ver: '02.03.00.00' });
      this.send(socket, request, 0, {}); return;
    }
    assert.ok([1, 4, 5, 7].includes(request.cmdtype), 'no delete or print/control command exists');
    if (request.cmdtype === 7) { this.send(socket, request, 0, { storage: ['emmc', 'udisk'], upload_storage: ['emmc'], allow_internal_model_download: true }); return; }
    if (request.cmdtype === 1) { this.send(socket, request, request.req.storage === 'external' ? 17 : 0, { file_lists: [] }); return; }
    if (request.cmdtype === 5 && binary === undefined) {
      this.uploadSequence = request.sequence;
      this.send(socket, request, this.initResult ?? 1, { chunk_size: this.chunkKiB ?? 255, offset: this.resumeOffset ?? 0 }); return;
    }
    if (request.cmdtype === 5) {
      assert.equal(request.sequence, this.uploadSequence);
      assert.equal(request.req.offset, this.chunks.reduce((n, c) => n + c.length, 0));
      assert.equal(request.req.size, binary.length);
      assert.equal(request.req.frag_id, this.chunks.length);
      this.chunks.push(Buffer.from(binary));
      if (this.progressReplies && !request.req.file_md5) this.send(socket, request, 1, { offset: request.req.offset + binary.length });
      if (request.req.file_md5) {
        assert.equal(request.req.file_md5, hash('md5', Buffer.concat(this.chunks)));
        this.send(socket, request, 0, this.uploadEcho);
      }
      return;
    }
    assert.equal(request.req.path, `/userdata/model/history/${name}`);
    assert.equal(request.req.offset, 0);
    const data = this.readbackBytes ?? this.bytes;
    const width = 20_480;
    for (let offset = 0, frag = 0; offset < data.length && !socket.destroyed; offset += width, frag++) {
      const binary = data.subarray(offset, Math.min(data.length, offset + width));
      const last = offset + binary.length === data.length;
      this.send(socket, request, last ? 0 : 1, { frag_id: frag, offset, size: binary.length, total: this.bytes.length,
        ...(last && !this.omitMd5 ? { file_md5: hash('md5', data) } : {}) }, binary);
    }
  }
}

async function fixture(t, overrides = {}, size = 600_019) {
  const dir = await mkdtemp(join(tmpdir(), 'media-transfer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.alloc(size); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const filePath = join(dir, 'checked.3mf'); await writeFile(filePath, bytes);
  const peer = new Peer(bytes, overrides);
  const options = { host: 'printer.invalid', serial, accessCode: 'TESTCODE', ca: Buffer.from('synthetic-ca'), filePath,
    snapshotSha256: hash('sha256', bytes), remoteName: name, assertActive() {}, deadlineMs: 2000 };
  const invoke = changes => verifiedUploadInternal({ ...options, ...changes }, { connect: peer.connect });
  return { dir, bytes, filePath, peer, options, invoke };
}

async function fails(t, overrides, reason, stage, changes, size) {
  const f = await fixture(t, overrides, size);
  await assert.rejects(f.invoke(changes), error => error instanceof MediaTransferError && error.reason === reason && (!stage || error.stage === stage));
  if (f.peer.socket) assert.equal(f.peer.socket.destroyed, true);
  return f;
}

test('verified transfer: fragmented TLS frames, multi-chunk pipeline, exact readback and strict identity', async t => {
  const f = await fixture(t, { progressReplies: true });
  const progress = [];
  const result = await f.invoke({ servername: 'sni.invalid', progress: value => progress.push(value) });
  assert.deepEqual(result, { storage: 'emmc', name, size: f.bytes.length, md5: hash('md5', f.bytes), sha256: hash('sha256', f.bytes), url: `brtc://emmc/${name}`, verifiedBy: 'readback' });
  assert.equal(f.peer.chunks.length, 3);
  assert.deepEqual(Buffer.concat(f.peer.chunks), f.bytes);
  assert.equal(f.peer.socket.destroyed, true);
  const tls = f.peer.tlsOptions;
  assert.equal(tls.port, 6000); assert.equal(tls.rejectUnauthorized, true); assert.equal(tls.minVersion, 'TLSv1.2');
  assert.equal(tls.servername, 'sni.invalid'); assert.deepEqual(tls.ca, Buffer.from('synthetic-ca'));
  assert.equal(tls.checkServerIdentity('sni.invalid', { subject: { CN: serial } }), undefined);
  assert.ok(tls.checkServerIdentity(serial, { subject: { CN: 'DIFFERENT' } }) instanceof Error);
  assert.deepEqual(f.peer.commands.filter(r => r.cmdtype === 1).map(r => r.req.storage), ['internal', 'emmc', 'external']);
  assert.equal(progress.at(-1).bytes, f.bytes.length); assert.equal(progress.at(-1).phase, 'readback');
  assert.deepEqual(await readdir(f.dir), ['checked.3mf'], 'readback never writes a peer-supplied path');
});

test('terminal download can omit peer MD5 because independently computed SHA256 is mandatory', async t => {
  const f = await fixture(t, { omitMd5: true }, 701);
  assert.equal((await f.invoke()).verifiedBy, 'readback');
});

test('download accepts a metadata-only initial continuation before ordered bytes', async t => {
  const f = await fixture(t, { before(socket, req) {
    if (req.cmdtype === 4) this.send(socket, req, 1, { total: this.bytes.length, offset: 0, size: 0 });
  } }, 1001);
  assert.equal((await f.invoke()).sha256, f.options.snapshotSha256);
});

test('download supports optional fragment fields and a separate empty terminal', async t => {
  const f = await fixture(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    this.send(socket, req, 1, { total: this.bytes.length });
    this.send(socket, req, 1, {}, this.bytes.subarray(0, 400));
    this.send(socket, req, 1, undefined, this.bytes.subarray(400));
    this.send(socket, req, 0, { total: this.bytes.length, file_md5: hash('md5', this.bytes) });
    return false;
  } }, 1001);
  assert.equal((await f.invoke()).verifiedBy, 'readback');
});

test('empty terminal with no reply object still requires the full checked byte stream', async t => {
  const f = await fixture(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    this.send(socket, req, 1, undefined, this.bytes);
    this.send(socket, req, 0);
    return false;
  } }, 1001);
  assert.equal((await f.invoke()).size, 1001);
});

test('a separate empty terminal cannot verify a truncated file', async t => {
  await fails(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    this.send(socket, req, 1, {}, this.bytes.subarray(0, 100));
    this.send(socket, req, 0);
    return false;
  } }, 'integrity', 'readback', undefined, 1001);
});

test('unbounded metadata-only continuation frames fail closed', async t => {
  await fails(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    for (let i = 0; i < 17; i++) this.send(socket, req, 1, { total: this.bytes.length });
    return false;
  } }, 'bounds', 'readback', undefined, 1001);
});

test('metadata heartbeat does not reset the independent readback idle deadline', async t => {
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  let download;
  const f = await fixture(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    download = () => this.send(socket, req, 1, { total: this.bytes.length });
    reached(); return false;
  } }, 1001);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = assert.rejects(f.invoke({ deadlineMs: 120_000 }), error => error.reason === 'timeout' && error.stage === 'readback');
  await ready;
  t.mock.timers.tick(9000);
  download();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1001);
  await failure;
  assert.equal(f.peer.socket.destroyed, true);
});

test('optional fields remain binding when a peer supplies an invalid ordered offset', async t => {
  await fails(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    this.send(socket, req, 1, {}, this.bytes.subarray(0, 400));
    this.send(socket, req, 0, { offset: 0 }, this.bytes.subarray(400));
    return false;
  } }, 'integrity', 'readback', undefined, 1001);
});

test('download bytes beyond checked size fail even without peer metadata', async t => {
  await fails(t, { before(socket, req) {
    if (req.cmdtype !== 4) return;
    this.send(socket, req, 0, {}, Buffer.concat([this.bytes, Buffer.from([1])]));
    return false;
  } }, 'integrity', 'readback', undefined, 1001);
});

test('upload pipelines without any intermediate ACK; terminal result0 needs no digest echo', async t => {
  const f = await fixture(t);
  assert.equal((await f.invoke()).sha256, f.options.snapshotSha256);
});

test('many upload progress replies drain concurrently rather than accumulate', async t => {
  const f = await fixture(t, { chunkKiB: 1, progressReplies: true }, 200_001);
  assert.equal((await f.invoke()).size, f.bytes.length);
  assert.ok(f.peer.chunks.length > 128);
});

for (const result of [19, 2, -9203]) test(`upload init rejects result ${result} before sending any file bytes`, async t => {
  const f = await fails(t, { initResult: result }, result === 19 ? 'collision' : 'remote-rejected', 'upload');
  assert.equal(f.peer.chunks.length, 0);
});

for (const offset of [1, -1, '0']) test(`upload refuses resume offset ${JSON.stringify(offset)}`, async t => {
  const f = await fails(t, { resumeOffset: offset }, 'protocol', 'upload'); assert.equal(f.peer.chunks.length, 0);
});

for (const chunkKiB of [0, 256, -1, 1.5]) test(`upload rejects invalid chunk size ${chunkKiB}`, async t => {
  await fails(t, { chunkKiB }, 'protocol', 'upload');
});

test('internal read capability missing fails before upload', async t => {
  const f = await fails(t, { json(json, req) { if (req.cmdtype === 7) delete json.reply.allow_internal_model_download; } }, 'unsupported', 'capability');
  assert.equal(f.peer.commands.some(r => r.cmdtype === 5), false);
});

test('explicit upload capability does not infer writability from a list alias', async t => {
  await fails(t, { json(json, req) { if (req.cmdtype === 7) json.reply.upload_storage = ['udisk']; } }, 'unsupported', 'capability');
});

for (const storage of ['internal', 'emmc', 'external']) test(`collision in ${storage} alias prevents init`, async t => {
  const f = await fails(t, { json(json, req) { if (req.cmdtype === 1 && req.req.storage === storage) { json.result = 0; json.reply.file_lists = [{ path: `/some/cache/${name.toUpperCase()}` }]; } } }, 'collision', 'list');
  assert.equal(f.peer.commands.some(r => r.cmdtype === 5), false);
});

test('changed local checked bytes fail before opening TLS', async t => {
  const f = await fails(t, {}, 'local-changed', 'local', { snapshotSha256: '0'.repeat(64) });
  assert.equal(f.peer.socket, undefined);
});

test('file mutation after initial hashing prevents terminal upload verification', async t => {
  const f = await fixture(t);
  // Use the init callback hook to hold its response until mutation has completed.
  f.peer.before = (socket, req, binary) => {
    if (req.cmdtype === 5 && binary === undefined) {
      f.peer.before = undefined;
      void writeFile(f.filePath, Buffer.alloc(f.bytes.length, 9)).then(() => f.peer.receive(socket, socket.writes.at(-1)));
      return false;
    }
  };
  await assert.rejects(f.invoke(), error => error.reason === 'local-changed' && error.uploadMayExist);
  assert.equal(f.peer.commands.some(r => r.cmdtype === 4), false);
});

test('filename alias collision fails closed before upload', async t => {
  await fails(t, { json(json, req) { if (req.cmdtype === 1) json.reply.file_lists = [{ filename: name }]; } }, 'collision', 'list');
});

test('missing file_lists is not silently treated as an empty storage', async t => {
  await fails(t, { json(json, req) { if (req.cmdtype === 1) delete json.reply.file_lists; } }, 'protocol', 'list');
});

test('early success while the upload still has unsent chunks is not accepted', async t => {
  await fails(t, { before(socket, req, binary) { if (req.cmdtype === 5 && binary && !req.req.file_md5) { this.send(socket, req, 0); return false; } } }, 'protocol', 'upload');
});

test('caller mutation after start cannot change destination or identity', async t => {
  const f = await fixture(t, {}, 600);
  f.options.progress = () => { f.options.remoteName = '../escape'; f.options.serial = 'CHANGED'; };
  const result = await verifiedUploadInternal(f.options, { connect: f.peer.connect });
  assert.equal(result.name, name); assert.equal(f.peer.tlsOptions.servername, serial);
});

test('same-size corrupt readback fails SHA256, never yields receipt', async t => {
  const f = await fixture(t); f.peer.readbackBytes = Buffer.alloc(f.bytes.length, 7);
  await assert.rejects(f.invoke(), error => error.reason === 'integrity' && error.stage === 'readback' && error.uploadMayExist);
});

for (const field of ['offset', 'size', 'total', 'frag_id', 'file_md5']) test(`download rejects wrong ${field}`, async t => {
  await fails(t, { json(json, req) { if (req.cmdtype === 4 && (field !== 'file_md5' || json.result === 0)) json.reply[field] = field === 'file_md5' ? '0'.repeat(32) : 999; } }, 'integrity', 'readback');
});

test('download refusal after upload is explicitly ambiguous remote-file state', async t => {
  await fails(t, { before(socket, req) { if (req.cmdtype === 4) { this.send(socket, req, 2); return false; } } }, 'remote-rejected', 'readback');
});

test('stale cmd/sequence responses are skipped, never accepted as current success', async t => {
  const f = await fixture(t, { before(socket, req) {
    if (req.cmdtype === 7) {
      this.send(socket, { ...req, cmdtype: 5 }, 0, {});
      this.send(socket, { ...req, sequence: req.sequence + 50 }, 0, {});
    }
  } }, 321);
  assert.equal((await f.invoke()).verifiedBy, 'readback');
});

test('oversized frame rejected from header before allocating advertised payload', async t => {
  await fails(t, { before(socket, req) { if (req.cmdtype === 7) {
    const header = Buffer.alloc(16); header.writeUInt32LE(0xffffffff); header.writeUInt32LE(0x0002013f, 4); socket.deliver(header); return false;
  } } }, 'bounds', 'capability');
});

test('bad magic still fails closed before uploading bytes', async t => {
  const f = await fails(t, { before(socket, req) { if (req.cmdtype === 7) {
    const header = frame(42, Buffer.from('{}')); socket.deliver(header); return false;
  } } }, 'protocol', 'capability');
  assert.equal(f.peer.chunks.length, 0);
});

test('nonzero opaque reserved DWORDs in login and control replies are accepted', async t => {
  // Synthetic opaque values reproduce the observed header shape without retaining
  // the printer's uninterpreted reserved bytes. FakeTls splits every header.
  const f = await fixture(t, { loginReserved: 0x13579bdf, controlReserved: 0xfedcba98 }, 1001);
  assert.equal((await f.invoke()).sha256, f.options.snapshotSha256);
  for (const bytes of f.peer.socket.writes) assert.equal(bytes.readUInt32LE(12), 0, 'TX reserved stays zero');
});

test('coalesced control replies with opaque reserved DWORDs retain cmd/sequence correlation', async t => {
  const f = await fixture(t, { loginReserved: 0x13579bdf, controlReserved: 0x13579bdf, before(socket, req) {
    if (req.cmdtype !== 7) return;
    const stale = { mtype: 12289, sequence: req.sequence + 1, cmdtype: 7, result: 0, reply: {} };
    const current = { mtype: 12289, sequence: req.sequence, cmdtype: 7, result: 0,
      reply: { storage: ['emmc'], upload_storage: ['emmc'], allow_internal_model_download: true } };
    socket.deliver(Buffer.concat([frame(0x0002013f, Buffer.from(JSON.stringify(stale)), 1), frame(0x0002013f, Buffer.from(JSON.stringify(current)), 2)]));
    return false;
  } }, 1001);
  assert.equal((await f.invoke()).verifiedBy, 'readback');
});

test('nonzero reserved cannot hide a rejected login ACK status', async t => {
  const f = await fails(t, { loginReserved: 0x13579bdf, loginStatus: 1 }, 'remote-rejected', 'login');
  assert.equal(f.peer.commands.length, 0); assert.equal(f.peer.chunks.length, 0);
});

test('truncated login ACK payload closes without setup or file writes', async t => {
  const f = await fails(t, { loginReply(socket) {
    const bytes = frame(0x0001013f, Buffer.alloc(4), 0x13579bdf);
    socket.deliver(bytes.subarray(0, 18)); socket.emit('end'); return false;
  } }, 'closed', 'login');
  assert.equal(f.peer.commands.length, 0); assert.equal(f.peer.chunks.length, 0);
});

test('oversized login frame is rejected before allocating payload or file writes', async t => {
  const f = await fails(t, { loginReply(socket) {
    const header = frame(0x0001013f, Buffer.alloc(0), 0x13579bdf); header.writeUInt32LE(0xffffffff);
    socket.deliver(header); return false;
  } }, 'bounds', 'login');
  assert.equal(f.peer.commands.length, 0); assert.equal(f.peer.chunks.length, 0);
});

test('peer text and credentials are not reflected in errors', async t => {
  const secret = 'private-token-private-host-private-key';
  const f = await fixture(t, { before(socket, req) { if (req.cmdtype === 7) { socket.emit('error', new Error(secret)); return false; } } });
  await assert.rejects(f.invoke(), error => !error.message.includes(secret) && !JSON.stringify(error).includes(secret));
});

test('total deadline bounds a silent peer and suppresses later writes', async t => {
  const f = await fixture(t, { before(_socket, req) { if (req.cmdtype === 7) return false; } }, 500);
  await assert.rejects(f.invoke({ deadlineMs: 35 }), error => error.reason === 'timeout' && !error.uploadMayExist);
  assert.equal(f.peer.socket.destroyed, true);
  assert.equal(f.peer.commands.some(r => r.cmdtype === 5), false);
});

test('cancellation during backpressure prevents late chunks, another transfer remains usable', async t => {
  const controller = new AbortController();
  const a = await fixture(t, { before(_socket, req, binary) { if (req.cmdtype === 5 && binary) { this.holdWrites = true; controller.abort(); } } });
  const b = await fixture(t, {}, 101);
  const [resultA, resultB] = await Promise.allSettled([a.invoke({ signal: controller.signal }), b.invoke()]);
  assert.equal(resultA.status, 'rejected'); assert.equal(resultA.reason.reason, 'cancelled');
  assert.equal(resultA.reason.uploadMayExist, true); assert.equal(resultB.status, 'fulfilled');
  assert.equal(a.peer.socket.destroyed, true);
  const writes = a.peer.socket.writes.length;
  for (const callback of a.peer.pendingWrites) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.peer.socket.writes.length, writes);
  assert.equal(a.peer.commands.some(r => r.cmdtype === 4), false);
});

test('assertActive expiry while awaiting init prevents every later file write', async t => {
  let active = true;
  const f = await fixture(t, { before(_socket, req, binary) { if (req.cmdtype === 5 && binary === undefined) active = false; } });
  await assert.rejects(f.invoke({ assertActive() { if (!active) throw new Error('private cancellation details'); } }), error => error.reason === 'cancelled');
  assert.equal(f.peer.chunks.length, 0);
});

test('already aborted signal opens no socket', async t => {
  const signal = AbortSignal.abort();
  const f = await fails(t, {}, 'cancelled', 'local', { signal }); assert.equal(f.peer.socket, undefined);
});

test('untrusted TLS authorization never reaches login', async t => {
  const f = await fixture(t);
  const connect = options => { const socket = f.peer.connect(options); socket.authorized = false; return socket; };
  await assert.rejects(verifiedUploadInternal(f.options, { connect }), error => error.reason === 'tls');
  assert.equal(f.peer.socket.writes.length, 0);
});

for (const changes of [{ remoteName: '../escape.3mf' }, { remoteName: 'not-unique.3mf' }, { accessCode: 'short' }, { ca: Buffer.alloc(0) }, { deadlineMs: 240001 }, { snapshotSha256: 'bad' }]) test(`invalid options rejected before connection ${Object.keys(changes)[0]}`, async t => {
  const f = await fails(t, {}, 'invalid-options', 'local', changes); assert.equal(f.peer.socket, undefined);
});
