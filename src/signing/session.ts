import { encodeSignedPrint, type PrintCommand } from './wire.js';
import { fail, SigningError, validateDeviceMaterial, type AppMaterial, type DeviceMaterial } from './pki.js';
import { SequenceStore } from './sequence.js';

export type ConnectionGeneration = string | number;
export type SigningReadiness = { state: 'DISCONNECTED' | 'INSTALLING' | 'READY' | 'BLOCKED'; reason: string; expiresAt?: string };
export type CommandInput = Omit<PrintCommand, 'sequence_id'> & { command: PrintCommand['command']; sequence_id?: string };
/** Internal session; production callers obtain it through createSigningSession.
 * The adapter must recheck its connection generation immediately before publish.
 * Bytes returned by signCommand are dispatch authority only for that generation.
 */
export class SigningSession {
  private epoch = 0;
  private generation?: ConnectionGeneration;
  private pending?: { sequence: string; epoch: number; deadline: number };
  private device?: DeviceMaterial;
  private materialExpiry?: number;
  private reason = 'SIGNING_DISCONNECTED';
  private state: SigningReadiness['state'] = 'DISCONNECTED';
  constructor(private readonly serial: string, private readonly app: AppMaterial, private readonly trustPem: string, private readonly sequences: SequenceStore, private readonly clock: () => number = Date.now) {}
  private now(): number {
    const now = this.clock(); if (!Number.isFinite(now) || now < 0) return fail('SIGNING_CLOCK_INVALID'); return now;
  }
  private alive(): void {
    if (this.now() < this.app.notBefore || this.now() >= this.app.expiresAt || (this.device && (this.now() < this.device.notBefore || this.now() >= this.device.expiresAt))) {
      this.epoch++; this.pending = undefined; this.device = undefined; this.state = 'BLOCKED'; this.reason = 'SIGNING_MATERIAL_EXPIRED';
      fail(this.reason);
    }
  }
  private current(epoch: number): void {
    if (this.epoch !== epoch) fail('SIGNING_CONNECTION_CHANGED');
    this.alive();
  }
  readiness(): SigningReadiness {
    try {
      this.alive();
      if (this.pending && this.now() >= this.pending.deadline) { this.epoch++; this.pending = undefined; this.state = 'BLOCKED'; this.reason = 'SIGNING_INSTALL_TIMEOUT'; }
    } catch (error) { this.epoch++; this.pending = undefined; this.device = undefined; this.state = 'BLOCKED'; this.reason = error instanceof SigningError ? error.code : 'SIGNING_NOT_READY'; }
    return { state: this.state, reason: this.reason, expiresAt: new Date(Math.min(this.app.expiresAt, this.materialExpiry ?? Infinity)).toISOString() };
  }
  async beginInstall(generation: ConnectionGeneration): Promise<{ sequence: string; payload: Buffer }> {
    if ((typeof generation !== 'string' && typeof generation !== 'number') || (typeof generation === 'string' && (!generation || generation.length > 128)) || (typeof generation === 'number' && !Number.isSafeInteger(generation))) return fail('SIGNING_GENERATION_INVALID');
    this.disconnect(); this.generation = generation; const epoch = this.epoch;
    this.alive();
    try {
      const sequence = await this.sequences.next(); this.current(epoch);
      this.pending = { sequence, epoch, deadline: this.now() + 15000 };
      this.state = 'INSTALLING'; this.reason = 'SIGNING_INSTALL_REPLY_REQUIRED';
      return { sequence, payload: Buffer.from(JSON.stringify({ security: { command: 'app_cert_install', sequence_id: sequence, app_cert: this.app.chainPem, crl: this.app.crlPem } }), 'utf8') };
    } catch (error) {
      if (this.epoch === epoch) { this.state = 'BLOCKED'; this.reason = error instanceof SigningError ? error.code : 'SIGNING_SEQUENCE_UNAVAILABLE'; }
      throw new SigningError(error instanceof SigningError ? error.code : 'SIGNING_INSTALL_FAILED');
    }
  }
  async acceptInstallReply(input: { topic: string; generation: ConnectionGeneration; reply: unknown }): Promise<boolean> {
    const pending = this.pending;
    if (!pending || input.topic !== `device/${this.serial}/report` || input.generation !== this.generation || pending.epoch !== this.epoch) return false;
    if (this.now() >= pending.deadline) { this.disconnect(); this.state = 'BLOCKED'; this.reason = 'SIGNING_INSTALL_TIMEOUT'; return false; }
    if (!input.reply || typeof input.reply !== 'object' || Array.isArray(input.reply)) return false;
    const security = (input.reply as Record<string, unknown>).security;
    if (!security || typeof security !== 'object' || Array.isArray(security)) return false;
    const reply = security as Record<string, unknown>;
    if (reply.command !== 'app_cert_install' || reply.sequence_id !== pending.sequence) return false;
    // Consume exactly once before async verification. Duplicates cannot race READY.
    this.pending = undefined;
    try {
      if (reply.result !== 'SUCCESS') return fail('SIGNING_INSTALL_REJECTED');
      if (typeof reply.printer_cert !== 'string') return fail('SIGNING_DEVICE_CERT_REQUIRED');
      const device = await validateDeviceMaterial(reply.printer_cert, this.trustPem, this.serial, this.now());
      this.current(pending.epoch);
      if (this.now() >= pending.deadline) return fail('SIGNING_INSTALL_TIMEOUT');
      this.device = device; this.materialExpiry = Math.min(this.app.expiresAt, device.expiresAt); this.alive(); this.state = 'READY'; this.reason = 'SIGNING_READY'; return true;
    } catch (error) {
      if (this.epoch === pending.epoch) { this.device = undefined; this.state = 'BLOCKED'; this.reason = error instanceof SigningError ? error.code : 'SIGNING_DEVICE_CERT_INVALID'; }
      return false;
    }
  }
  async signCommand(command: CommandInput): Promise<Buffer> {
    this.alive();
    if (this.state !== 'READY' || !this.device) return fail('SIGNING_NOT_READY');
    const epoch = this.epoch, device = this.device;
    try {
      // Snapshot before awaiting: caller cannot mutate a checked command mid-flight.
      const snapshot = JSON.parse(JSON.stringify(command)) as PrintCommand;
      const sequence = await this.sequences.next(); this.current(epoch);
      const bytes = encodeSignedPrint({ ...snapshot, sequence_id: sequence }, this.app.certId, this.app.privateKey, device.publicKey);
      this.current(epoch);
      return bytes;
    } catch (error) {
      if (error instanceof SigningError) {
        if (this.epoch === epoch && error.code === 'SIGNING_SEQUENCE_UNAVAILABLE') { this.device = undefined; this.state = 'BLOCKED'; this.reason = error.code; }
        throw error;
      }
      return fail('SIGNING_COMMAND_INVALID');
    }
  }
  disconnect(): void {
    this.epoch++; this.generation = undefined; this.pending = undefined; this.device = undefined; this.materialExpiry = undefined; this.state = 'DISCONNECTED'; this.reason = 'SIGNING_DISCONNECTED';
  }
}
