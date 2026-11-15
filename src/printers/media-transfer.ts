import tls, { type ConnectionOptions, type TLSSocket } from 'node:tls';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Independently implemented from the published wire observations in
// ClusterM/open-bamboo-networking/research/06.04-port-6000.md and 09.06-commands.md.
// This module transfers bytes only. It never sends MQTT, print, or delete commands.
const LOGIN = 0x0101013f;
const LOGIN_ACK = 0x0001013f;
const CONTROL = 0x0102013f;
const CONTROL_ACK = 0x0002013f;
const MAX_FRAME = 1024 * 1024;
const MAX_JSON = 64 * 1024;
const MAX_QUEUE_BYTES = 2 * MAX_FRAME;
const MAX_FILE = 512 * 1024 * 1024;
const IDLE_MS = 10_000;

export interface VerifiedInternalUpload {
  storage: 'emmc';
  name: string;
  size: number;
  md5: string;
  sha256: string;
  url: string;
  verifiedBy: 'readback';
}

export interface VerifiedUploadInternalOptions {
  host: string;
  serial: string;
  accessCode: string;
  ca: Buffer;
  servername?: string;
  filePath: string;
  snapshotSha256: string;
  /** A unique, UUID-bearing flat basename chosen by the caller. */
  remoteName: string;
  signal?: AbortSignal;
  assertActive: () => void;
  deadlineMs?: number;
  progress?: (progress: { phase: 'upload' | 'readback'; bytes: number; total: number }) => void;
}

export interface MediaTransferDependencies {
  /** Test seam only; production always uses node:tls with strict verification. */
  connect: (options: ConnectionOptions) => TLSSocket;
}

type Stage = 'local' | 'tls' | 'login' | 'setup' | 'capability' | 'list' | 'upload' | 'readback';
type Failure = 'invalid-options' | 'local-changed' | 'tls' | 'closed' | 'timeout' | 'cancelled' |
  'protocol' | 'bounds' | 'unsupported' | 'collision' | 'remote-rejected' | 'integrity';

export class MediaTransferError extends Error {
  constructor(readonly stage: Stage, readonly reason: Failure, readonly uploadMayExist: boolean) {
    super(`Printer media transfer failed (${stage}: ${reason}).${uploadMayExist ? ' A remote partial file may remain; do not retry automatically.' : ''}`);
    this.name = 'MediaTransferError';
  }
}

type Frame = { magic: number; payload: Buffer };
type Json = Record<string, unknown>;
type Reply = { json: Json; binary: Buffer };
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** One connection, one operation. No replay, resume, shared socket, or hidden retry. */
class TransferSession {
  stage: Stage = 'local';
  uploadMayExist = false;
  private readonly expires: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private socket?: TLSSocket;
  private failure?: MediaTransferError;
  private readonly pending = new Set<(error: MediaTransferError) => void>();
  private readonly frames: Frame[] = [];
  private queueBytes = 0;
  private reader?: (frame: Frame) => void;
  private header = Buffer.alloc(16);
  private headerUsed = 0;
  private payload?: Buffer;
  private payloadUsed = 0;
  private payloadMagic = 0;
  private wireSequence = 1;
  private rpcSequence = 1;
  private readbackIdleTimer?: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.fail('cancelled');

  constructor(private readonly options: VerifiedUploadInternalOptions, private readonly deps: MediaTransferDependencies) {
    const duration = options.deadlineMs ?? 120_000;
    this.expires = performance.now() + duration;
    this.timer = setTimeout(() => this.fail('timeout'), duration);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  error(reason: Failure): MediaTransferError { return new MediaTransferError(this.stage, reason, this.uploadMayExist); }

  active(): void {
    if (this.failure) throw this.failure;
    if (this.options.signal?.aborted) { this.fail('cancelled'); throw this.failure; }
    if (performance.now() >= this.expires) { this.fail('timeout'); throw this.failure; }
    try { this.options.assertActive(); } catch { this.fail('cancelled'); throw this.failure; }
  }

  private fail(reason: Failure): void {
    if (this.failure) return;
    this.failure = this.error(reason);
    clearTimeout(this.readbackIdleTimer);
    this.reader = undefined;
    for (const reject of this.pending) reject(this.failure);
    this.pending.clear();
    this.frames.length = 0;
    this.queueBytes = 0;
    this.socket?.destroy();
  }

  reject(error: unknown): void { this.fail(error instanceof MediaTransferError ? error.reason : 'protocol'); }

  /** Bound filesystem waits too; late resolution has no continuation in this operation. */
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.active();
    return new Promise<T>((resolve, reject) => {
      const failed = (error: MediaTransferError) => reject(error);
      this.pending.add(failed);
      promise.then(value => {
        this.pending.delete(failed);
        try { this.active(); resolve(value); } catch (error) { reject(error); }
      }, () => { this.pending.delete(failed); reject(this.failure ?? this.error('protocol')); });
    });
  }

  async connect(): Promise<void> {
    this.stage = 'tls';
    this.active();
    const socket = this.deps.connect({ host: this.options.host, port: 6000,
      ca: this.options.ca, servername: this.options.servername ?? this.options.serial,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      // SNI never changes the identity being verified.
      checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(this.options.serial, cert),
    });
    this.socket = socket;
    socket.on('error', () => this.fail(this.stage === 'tls' ? 'tls' : 'closed'));
    socket.on('close', () => this.fail('closed'));
    socket.on('end', () => this.fail('closed'));
    socket.on('timeout', () => this.fail('timeout'));
    socket.on('data', (data: Buffer) => this.receive(data));
    socket.setTimeout(IDLE_MS);
    await this.wait(new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => {
        if (socket.authorized !== true) { this.fail('tls'); reject(this.failure); } else resolve();
      });
    }));
  }

  private receive(data: Buffer): void {
    if (this.failure) return;
    try {
      this.active();
      let offset = 0;
      while (offset < data.length) {
        if (!this.payload) {
          const take = Math.min(16 - this.headerUsed, data.length - offset);
          data.copy(this.header, this.headerUsed, offset, offset + take);
          offset += take; this.headerUsed += take;
          if (this.headerUsed !== 16) continue;
          const size = this.header.readUInt32LE(0);
          // RX byte 7 varies on observed X2D replies carrying ordinary correlated
          // JSON. Its cause is unknown: validate the marker/channel, not that byte.
          // Normalize only received frames; transmitted full constants stay intact.
          this.payloadMagic = this.header.readUInt32LE(4) & 0x00ffffff;
          if (size > MAX_FRAME) throw this.error('bounds');
          // The final DWORD is reserved, not an authenticated status or length.
          // X2D replies can leave it nonzero; send zero, but do not interpret it.
          if (![LOGIN_ACK, CONTROL_ACK].includes(this.payloadMagic)) throw this.error('protocol');
          this.payload = Buffer.alloc(size);
          this.payloadUsed = 0;
        }
        const take = Math.min(this.payload.length - this.payloadUsed, data.length - offset);
        data.copy(this.payload, this.payloadUsed, offset, offset + take);
        offset += take; this.payloadUsed += take;
        if (this.payloadUsed === this.payload.length) {
          const frame = { magic: this.payloadMagic, payload: this.payload };
          this.payload = undefined; this.headerUsed = 0;
          if (this.reader) { const reader = this.reader; this.reader = undefined; reader(frame); }
          else {
            if (this.frames.length >= 64 || this.queueBytes + frame.payload.length > MAX_QUEUE_BYTES) throw this.error('bounds');
            this.frames.push(frame); this.queueBytes += frame.payload.length;
          }
        }
      }
    } catch (error) { this.fail(error instanceof MediaTransferError ? error.reason : 'protocol'); }
  }

  private async nextFrame(): Promise<Frame> {
    this.active();
    const frame = this.frames.shift();
    if (frame) { this.queueBytes -= frame.payload.length; return frame; }
    return this.wait(new Promise<Frame>(resolve => { this.reader = resolve; }));
  }

  private async write(buffer: Buffer): Promise<void> {
    this.active();
    // A completed write callback bounds the queued bytes without waiting for any wire reply.
    await this.wait(new Promise<void>((resolve, reject) => {
      this.socket!.write(buffer, error => error ? reject(this.error('closed')) : resolve());
    }));
  }

  private async send(magic: number, payload: Buffer): Promise<void> {
    if (payload.length > MAX_FRAME) throw this.error('bounds');
    const header = Buffer.alloc(16);
    header.writeUInt32LE(payload.length, 0); header.writeUInt32LE(magic, 4);
    header.writeUInt32LE(this.wireSequence++, 8);
    await this.write(Buffer.concat([header, payload]));
  }

  async bootstrap(): Promise<void> {
    this.stage = 'login';
    const login = Buffer.alloc(16); login.write('bblp', 0, 'ascii'); login.write(this.options.accessCode, 8, 'ascii');
    await this.send(LOGIN, login);
    const ack = await this.nextFrame();
    if (ack.magic !== LOGIN_ACK || ack.payload.length !== 4 || ack.payload.readUInt32LE(0) !== 0) throw this.error('remote-rejected');
    this.stage = 'setup';
    await this.send(CONTROL, Buffer.from(JSON.stringify({ sequence: 0, mtype: 12291,
      req: { t_av: 1, mtype: 12289, peer_t: 3, pid: randomBytes(8).toString('hex'), ver: '02.03.00.00' } })));
    const setup = await this.reply(0, undefined, 12291);
    if (setup.json.result !== 0 || setup.binary.length) throw this.error('remote-rejected');
  }

  newSequence(): number { return this.rpcSequence++; }

  async command(cmdtype: number, sequence: number, req: Json, binary?: Buffer): Promise<void> {
    const json = Buffer.from(JSON.stringify({ mtype: 12289, cmdtype, sequence, req }));
    if (json.length > MAX_JSON) throw this.error('bounds');
    await this.send(CONTROL, binary ? Buffer.concat([json, Buffer.from('\n\n'), binary]) : json);
  }

  async reply(sequence: number, cmdtype?: number, mtype = 12289): Promise<Reply> {
    // Unsolicited notifications/stale replies are filtered, never mistaken for success.
    for (let skipped = 0; skipped < 128; skipped++) {
      const frame = await this.nextFrame();
      if (frame.magic !== CONTROL_ACK) throw this.error('protocol');
      const separator = frame.payload.indexOf('\n\n');
      const jsonBytes = separator < 0 ? frame.payload : frame.payload.subarray(0, separator);
      if (jsonBytes.length > MAX_JSON) throw this.error('bounds');
      let json: unknown;
      try { json = JSON.parse(jsonBytes.toString('utf8')); } catch { throw this.error('protocol'); }
      if (!object(json)) throw this.error('protocol');
      if (json.sequence !== sequence || json.cmdtype !== cmdtype || json.mtype !== mtype) continue;
      if (!Number.isSafeInteger(json.result)) throw this.error('protocol');
      return { json, binary: separator < 0 ? Buffer.alloc(0) : frame.payload.subarray(separator + 2) };
    }
    throw this.error('bounds');
  }

  async request(cmdtype: number, req: Json): Promise<Reply> {
    const sequence = this.newSequence();
    await this.command(cmdtype, sequence, req);
    return this.reply(sequence, cmdtype);
  }

  progress(phase: 'upload' | 'readback', bytes: number, total: number): void {
    this.active();
    this.options.progress?.({ phase, bytes, total });
    this.active();
  }

  readbackProgress(): void {
    this.active();
    clearTimeout(this.readbackIdleTimer);
    // TLS activity alone is insufficient: empty progress notifications must not
    // keep a stalled readback alive. Reset only when actual file bytes arrive.
    this.readbackIdleTimer = setTimeout(() => this.fail('timeout'), IDLE_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.readbackIdleTimer);
    this.options.signal?.removeEventListener('abort', this.abort);
    this.socket?.destroy();
  }
}

function validate(options: VerifiedUploadInternalOptions): void {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  if (typeof options.host !== 'string' || !options.host || options.host.length > 253 || /[\s\x00-\x1f/\\]/.test(options.host) ||
      typeof options.serial !== 'string' || !/^[a-z0-9]{6,32}$/i.test(options.serial) ||
      typeof options.accessCode !== 'string' || !/^[\x21-\x7e]{8}$/.test(options.accessCode) ||
      !Buffer.isBuffer(options.ca) || !options.ca.length || options.ca.length > 256 * 1024 ||
      (options.servername !== undefined && (typeof options.servername !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(options.servername))) ||
      typeof options.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.snapshotSha256) ||
      typeof options.remoteName !== 'string' || options.remoteName.length > 180 || !/^[a-z0-9][a-z0-9._-]*\.3mf$/i.test(options.remoteName) ||
      !uuid.test(options.remoteName) || options.remoteName.includes('..') ||
      typeof options.assertActive !== 'function' || typeof options.filePath !== 'string' || !options.filePath ||
      (options.deadlineMs !== undefined && (!integer(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 240_000))) {
    throw new MediaTransferError('local', 'invalid-options', false);
  }
}

async function hashFile(session: TransferSession, file: FileHandle, size: number): Promise<{ md5: string; sha256: string }> {
  const md5 = createHash('md5'); const sha256 = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(256 * 1024, size));
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await session.wait(file.read(buffer, 0, Math.min(buffer.length, size - offset), offset));
    if (!bytesRead) throw session.error('local-changed');
    md5.update(buffer.subarray(0, bytesRead)); sha256.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}

function replyObject(reply: Reply, session: TransferSession): Json {
  if (!object(reply.json.reply) || reply.binary.length) throw session.error('protocol');
  return reply.json.reply;
}

async function checkCapabilityAndCollisions(session: TransferSession, name: string): Promise<void> {
  session.stage = 'capability';
  const ability = await session.request(7, { peer: 'studio', api_version: 2 });
  if (ability.json.result !== 0) throw session.error('remote-rejected');
  const data = replyObject(ability, session);
  if (!Array.isArray(data.storage) || !data.storage.every(x => typeof x === 'string') || !data.storage.includes('emmc') ||
      (data.upload_storage !== undefined && (!Array.isArray(data.upload_storage) || !data.upload_storage.includes('emmc'))) ||
      data.allow_internal_model_download !== true) throw session.error('unsupported');
  session.stage = 'list';
  // Read both internal aliases, and the external cache when available. A list alias
  // is never used to infer write support: only explicit emmc is uploaded below.
  for (const storage of ['internal', 'emmc', 'external']) {
    const list = await session.request(1, { type: 'model', api_version: 2, notify: 'DETAIL', storage });
    if (list.json.result === 17 && storage === 'external') continue;
    if (list.json.result !== 0) throw session.error('remote-rejected');
    const data = replyObject(list, session);
    if (!Array.isArray(data.file_lists) || data.file_lists.length > 10_000) throw session.error('protocol');
    for (const entry of data.file_lists) {
      if (!object(entry)) throw session.error('protocol');
      // Published browser rows can contain a flat name or an absolute path.
      const paths = [entry.name, entry.path, entry.file, entry.filename].filter((x): x is string => typeof x === 'string');
      if (!paths.length) throw session.error('protocol');
      if (paths.some(path => path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === name.toLowerCase())) throw session.error('collision');
    }
  }
}

async function upload(session: TransferSession, options: VerifiedUploadInternalOptions, file: FileHandle, size: number, hashes: { md5: string; sha256: string }): Promise<void> {
  session.stage = 'upload';
  const sequence = session.newSequence();
  session.uploadMayExist = true; // init can create remote state even if its reply is lost.
  await session.command(5, sequence, { type: 'model', storage: 'emmc', path: options.remoteName, total: size });
  const init = await session.reply(sequence, 5);
  if (init.json.result === 19) throw session.error('collision');
  if (init.json.result !== 1) throw session.error('remote-rejected');
  const settings = replyObject(init, session);
  if (!integer(settings.chunk_size) || settings.chunk_size < 1 || settings.chunk_size > 255 || settings.offset !== 0) throw session.error('protocol');
  const chunkSize = settings.chunk_size * 1024;
  const md5 = createHash('md5'); const sha256 = createHash('sha256');
  let finalSubmitted = false;
  let terminal: Reply | undefined;
  let terminalError: unknown;
  // Drain while writing, without ever awaiting a fragment ACK. Firmware progress
  // frames must not fill either peer's socket buffers during a large pipeline.
  const draining = (async () => {
    for (let replies = 0; replies < Math.ceil(size / chunkSize) * 2 + 128; replies++) {
      const response = await session.reply(sequence, 5);
      if (response.binary.length) throw session.error('protocol');
      if (response.json.result === 1) continue;
      if (response.json.result !== 0) throw session.error('remote-rejected');
      if (!finalSubmitted) throw session.error('protocol');
      terminal = response;
      return;
    }
    throw session.error('bounds');
  })().catch(error => { terminalError = error; session.reject(error); });
  let offset = 0;
  for (let frag = 0; offset < size; frag++) {
    const buffer = Buffer.alloc(Math.min(chunkSize, size - offset));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await session.wait(file.read(buffer, used, buffer.length - used, offset + used));
      if (!bytesRead) throw session.error('local-changed');
      used += bytesRead;
    }
    md5.update(buffer); sha256.update(buffer);
    const req: Json = { frag_id: frag, offset, size: buffer.length };
    if (offset + buffer.length === size) {
      if (md5.digest('hex') !== hashes.md5 || sha256.digest('hex') !== hashes.sha256 || (await session.wait(file.stat())).size !== size) throw session.error('local-changed');
      req.file_md5 = hashes.md5;
      finalSubmitted = true;
    }
    await session.command(5, sequence, req, buffer);
    offset += buffer.length;
    session.progress('upload', offset, size);
  }
  await draining;
  if (terminalError) throw terminalError;
  if (!terminal) throw session.error('protocol');
  // Stock's final ACK is result:0 only. Check integrity fields if a peer adds them;
  // an ACK alone can never produce a verified receipt (readback below is mandatory).
  if (terminal.json.reply !== undefined) {
    if (!object(terminal.json.reply)) throw session.error('protocol');
    const echo = terminal.json.reply;
    if ((echo.total !== undefined && echo.total !== size) || (echo.file_md5 !== undefined && echo.file_md5 !== hashes.md5)) throw session.error('integrity');
  }
}

async function verifyReadback(session: TransferSession, options: VerifiedUploadInternalOptions, size: number, hashes: { md5: string; sha256: string }): Promise<void> {
  session.stage = 'readback';
  session.readbackProgress();
  const sequence = session.newSequence();
  await session.command(4, sequence, { path: `/userdata/model/history/${options.remoteName}`, offset: 0 });
  const md5 = createHash('md5'); const sha256 = createHash('sha256');
  let offset = 0; let frag = 0; let emptyContinuations = 0;
  for (;;) {
    const response = await session.reply(sequence, 4);
    if (![0, 1].includes(response.json.result as number)) throw session.error('remote-rejected');
    if (response.json.reply !== undefined && !object(response.json.reply)) throw session.error('protocol');
    const metadata: Json = response.json.reply === undefined ? {} : response.json.reply as Json;
    if (metadata.mem_dl_param_size !== undefined) throw session.error('protocol');
    if ((metadata.offset !== undefined && metadata.offset !== offset) ||
        (metadata.size !== undefined && metadata.size !== response.binary.length) ||
        (metadata.total !== undefined && metadata.total !== size) ||
        (metadata.frag_id !== undefined && metadata.frag_id !== frag) ||
        (metadata.file_md5 !== undefined && metadata.file_md5 !== hashes.md5) ||
        offset + response.binary.length > size) throw session.error('integrity');
    if (response.json.result === 1 && response.binary.length === 0 && ++emptyContinuations > 16) throw session.error('bounds');
    md5.update(response.binary); sha256.update(response.binary);
    offset += response.binary.length;
    if (response.binary.length) {
      frag++; emptyContinuations = 0;
      session.readbackProgress();
      session.progress('readback', offset, size);
    }
    if (response.json.result === 0) {
      if (offset !== size || (metadata.file_md5 !== undefined && metadata.file_md5 !== hashes.md5) || md5.digest('hex') !== hashes.md5 || sha256.digest('hex') !== hashes.sha256) throw session.error('integrity');
      return;
    }
  }
}

export async function verifiedUploadInternal(options: VerifiedUploadInternalOptions, dependencies: MediaTransferDependencies = { connect: options => tls.connect(options) }): Promise<VerifiedInternalUpload> {
  validate(options);
  // Keep caller/progress-callback mutation from changing an in-flight destination
  // or the identity against which the connection is verified.
  options = { ...options, ca: Buffer.from(options.ca) };
  const session = new TransferSession(options, dependencies);
  let file: FileHandle | undefined;
  try {
    session.active();
    // No peer-controlled path ever reaches the filesystem. Do not follow a final symlink.
    const opening = open(options.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    // Close a handle even if the operation expires while the open is pending.
    opening.then(handle => { if (!file) { try { session.active(); } catch { void handle.close(); } } }, () => {});
    file = await session.wait(opening);
    const stat = await session.wait(file.stat());
    if (!stat.isFile() || !integer(stat.size) || stat.size < 1 || stat.size > MAX_FILE) throw session.error('bounds');
    const hashes = await hashFile(session, file, stat.size);
    if (hashes.sha256 !== options.snapshotSha256) throw session.error('local-changed');
    await session.connect();
    await session.bootstrap();
    await checkCapabilityAndCollisions(session, options.remoteName);
    await upload(session, options, file, stat.size, hashes);
    await verifyReadback(session, options, stat.size, hashes);
    session.active();
    return { storage: 'emmc', name: options.remoteName, size: stat.size, ...hashes,
      url: `brtc://emmc/${options.remoteName}`, verifiedBy: 'readback' };
  } catch (error) {
    if (error instanceof MediaTransferError) throw error;
    throw session.error('protocol');
  } finally {
    session.dispose();
    // Closing a descriptor cannot authorize another write, and must not extend
    // a deadline if an earlier filesystem operation is still settling.
    void file?.close().catch(() => {});
  }
}
