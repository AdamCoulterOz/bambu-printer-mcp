import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connectDtls, DtlsError } from '../dist/tutk-direct/dtls.js';

// The digest of this synthetic password contains a NUL. The independent peer
// gets the already normalized key to catch incorrect password derivation.
const password = 'test-only-password-22';
const psk = '3e1fc53db232825e0b6200000000000000000000000000000000000000000000';
const suites = ['ECDHE-PSK-AES256-CBC-SHA384', 'ECDHE-PSK-CHACHA20-POLY1305'];
let location;
let fixture;

after(() => {
  if (location) rmSync(location, { recursive: true, force: true });
});

function peerBinary(t) {
  if (fixture) return fixture;
  const headers = spawnSync('pkg-config', ['--cflags', '--libs', 'openssl'], { encoding: 'utf8', timeout: 3000 });
  const compiler = spawnSync('cc', ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (headers.status !== 0 || compiler.status !== 0) {
    t.skip('The optional OpenSSL loopback fixture needs a C compiler and OpenSSL development headers');
    return undefined;
  }
  location = mkdtempSync(join(tmpdir(), 'tutk-dtls-peer-'));
  const binary = join(location, 'peer');
  const source = fileURLToPath(new URL('./support/tutk-dtls-peer.c', import.meta.url));
  const compiled = spawnSync('cc', ['-o', binary, source, ...headers.stdout.trim().split(/\s+/u)], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(compiled.status, 0, compiled.stderr);
  fixture = binary;
  return binary;
}

class LoopbackPath {
  socket = createSocket('udp4');
  sent = [];
  packets = [];
  incoming = new EventEmitter();

  constructor(port) {
    this.socket.on('message', (data) => {
      this.packets.push(data);
      this.incoming.emit('packet');
    });
    this.ready = once(this.socket, 'connect', { signal: AbortSignal.timeout(2000) });
    this.socket.connect(port, '127.0.0.1');
  }

  async send(data, epoch, sequence, signal) {
    signal?.throwIfAborted();
    this.sent.push({ data, epoch, sequence });
    await new Promise((resolve, reject) => this.socket.send(data, (error) => error ? reject(error) : resolve()));
  }

  async receive(deadline, signal) {
    if (!this.packets.length) await once(this.incoming, 'packet', { signal });
    return this.packets.shift();
  }
}

async function withPeer(binary, suite, echoes, action) {
  const child = spawn(binary, [suite, psk, String(echoes)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  let path;
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(2000) });
    const port = Number(line);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    path = new LoopbackPath(port);
    await path.ready;
    await action(path, exited);
  } finally {
    lines.close();
    path?.socket.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}

for (const suite of suites) {
  test(`DTLS ${suite} interoperates with independent OpenSSL and rejects forged or stale records`, async (t) => {
    const binary = peerBinary(t);
    if (!binary) return;
    await withPeer(binary, suite, 3, async (path, exited) => {
      const start = performance.now();
      const session = await connectDtls(path, password, { deadline: start + 6000, handshakeTimeoutMs: 1000 });
      try {
        assert.deepEqual(path.sent.map(({ epoch, sequence }) => [epoch, sequence]), [[0, 0], [0, 0], [0, 1]]);
        assert.deepEqual(path.sent[0].data, path.sent[1].data);
        // An authenticated session outlives the handshake phase bound.
        await delay(Math.max(0, start + 1010 - performance.now()));
        for (const data of ['first', 'second', 'third']) await session.send(Buffer.from(data));
        const echoed = [];
        const echoDeadline = performance.now() + 2000;
        for (let index = 0; index < 3; index += 1) {
          echoed.push(await path.receive(echoDeadline, AbortSignal.timeout(2000)));
        }
        const [first, second, third] = echoed;
        const forged = Buffer.from(first);
        forged.fill(0xff, 5, 11); // Invalid sequence must leave the replay window unchanged.
        const altered = Buffer.from(first);
        altered[altered.length - 1] ^= 1;
        path.packets.push(forged, altered, third, first, first, second);
        for (const data of ['third', 'first', 'second']) {
          assert.deepEqual(await session.receive(performance.now() + 1000), Buffer.from(data));
        }
        assert.equal(await session.receive(performance.now() + 20), undefined);
        assert.equal((await exited)[0], 0);
        const waiting = session.receive(performance.now() + 2000);
        const settled = assert.rejects(waiting, /closed/u);
        session.close();
        await settled;
      } finally {
        session.close();
      }
      await assert.rejects(session.send(Buffer.from('after closure')), /closed/u);
    });
  });

  test(`DTLS ${suite} fails authentication with a different password`, async (t) => {
    const binary = peerBinary(t);
    if (!binary) return;
    await withPeer(binary, suite, 1, async (path) => {
      await assert.rejects(
        connectDtls(path, 'incorrect', { deadline: performance.now() + 6000, handshakeTimeoutMs: 1000 }),
        (error) => error instanceof DtlsError && /final handshake flight|deadline expired|Finished flight/u.test(error.message),
      );
      assert.deepEqual(path.sent.map(({ sequence }) => sequence), [0, 0, 1]);
    });
  });
}

test('DTLS abort cancels the pending handshake receive and there is no late send', async () => {
  const controller = new AbortController();
  const events = new EventEmitter();
  const sent = [];
  let settled = false;
  const path = {
    async send(data, epoch, sequence) { sent.push({ data, epoch, sequence }); },
    async receive(_deadline, signal) {
      try {
        const waiting = once(events, 'packet', { signal });
        events.emit('receiving');
        await waiting;
      } finally {
        settled = true;
      }
    },
  };
  const receiving = once(events, 'receiving');
  const aborted = assert.rejects(connectDtls(path, password, {
    deadline: performance.now() + 10000, signal: controller.signal,
  }), /closed/u);
  await receiving;
  controller.abort();
  await aborted;
  assert.ok(settled);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test('DTLS rejects unsupported suites and missing mandatory protections before the key exchange', async () => {
  function handshake(kind, sequence, body) {
    const header = Buffer.alloc(12);
    header[0] = kind;
    header.writeUIntBE(body.length, 1, 3);
    header.writeUInt16BE(sequence, 4);
    header.writeUIntBE(body.length, 9, 3);
    return Buffer.concat([header, body]);
  }

  for (const [suite, extensions, error] of [
    [0x00a8, Buffer.from('00170000', 'hex'), /cipher suite/u],
    [0xccac, Buffer.alloc(0), /cipher protections/u],
    [0xc038, Buffer.from('00170000', 'hex'), /cipher protections/u],
  ]) {
    const hello = Buffer.alloc(40);
    hello.writeUInt16BE(0xfefd);
    hello.writeUInt16BE(suite, 35);
    hello.writeUInt16BE(extensions.length, 38);
    const empty = Buffer.alloc(0);
    const messages = Buffer.concat([
      handshake(2, 0, Buffer.concat([hello, extensions])), handshake(12, 1, empty), handshake(14, 2, empty),
    ]);
    const header = Buffer.alloc(13);
    header[0] = 22;
    header.writeUInt16BE(0xfefd, 1);
    header.writeUInt16BE(messages.length, 11);
    const flight = Buffer.concat([header, messages]);
    const sent = [];
    const path = {
      async send(_data, _epoch, sequence) { sent.push(sequence); },
      async receive() { return flight; },
    };
    await assert.rejects(connectDtls(path, password, { deadline: performance.now() + 1000 }), error);
    assert.deepEqual(sent, [0, 0]);
  }
});
