import * as mqtt from "mqtt";
import { AccountManager } from "./account/index.js";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import type { CommandInput } from "./signing/index.js";

/** The cryptographic session owns trust validation and the persistent sequence. */
export interface SigningSession {
  beginInstall(generation: number): Promise<{ sequence: string | number; payload: Buffer }>;
  acceptInstallReply(input: { topic: string; generation: number; reply: unknown }): Promise<boolean>;
  signCommand(command: CommandInput): Promise<Buffer>;
  disconnect(): void;
  readiness(): { state: string; reason: string; expiresAt?: string };
}
export interface SignedTransportOptions {
  serial: string;
  url: string;
  username: string;
  password: string;
  sessionFactory: () => Promise<SigningSession>;
  connect?: typeof mqtt.connect;
  timeoutMs?: number;
  tlsCa?: Buffer;
  tlsServername?: string;
  beforePublish?: () => Promise<void>;
  onPublish?: () => void;
  assertActive?: () => void;
  accountGuard?: { assertCurrent(): Promise<void>; assertGenerationCurrent(): void };
}

/** A private, one-shot writer. MQTT reconnect and offline command queues are disabled. */
export class SignedTransport {
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private current?: { client: mqtt.MqttClient; session?: SigningSession };
  constructor(private readonly options: SignedTransportOptions) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.serial)) throw new Error("Invalid printer identity for signed control.");
    let endpoint: URL;
    try { endpoint = new URL(options.url); } catch { throw new Error("Invalid signed MQTT endpoint."); }
    if (endpoint.protocol !== "mqtts:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname && endpoint.pathname !== "/")) {
      throw new Error("Signed control requires a TLS MQTT endpoint without embedded credentials or options.");
    }
  }
  close(): void {
    this.generation++;
    const current = this.current;
    this.current = undefined;
    current?.session?.disconnect();
    current?.client.end(true);
  }
  send(command: CommandInput, signal?: AbortSignal): Promise<void> {
    const work = this.tail.then(() => this.sendOnce(command, signal));
    this.tail = work.catch(() => {});
    return work;
  }
  sendLight(light: string, mode: string, signal?: AbortSignal): Promise<void> {
    if (!["chamber_light", "chamber_light2"].includes(light) || !["on", "off", "flashing"].includes(mode)) return Promise.reject(new Error("Invalid typed light control."));
    const work = this.tail.then(() => this.sendOnce(undefined, signal, { light, mode }));
    this.tail = work.catch(() => {});
    return work;
  }
  private async sendOnce(command: CommandInput | undefined, signal?: AbortSignal, light?: { light: string; mode: string }): Promise<void> {
    signal?.throwIfAborted();
    const generation = ++this.generation;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("Signed control cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Signed control timed out; check printer status before retrying.")), this.options.timeoutMs ?? 15_000);
    let session: SigningSession | undefined;
    let client: mqtt.MqttClient | undefined;
    const request = `device/${this.options.serial}/request`;
    const report = `device/${this.options.serial}/report`;
    const guard = () => {
      controller.signal.throwIfAborted();
      this.options.assertActive?.();
      this.options.accountGuard?.assertGenerationCurrent();
      if (generation !== this.generation || !client?.connected) throw new Error("Signed control connection is no longer active.");
    };
    const cancellable = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) return onAbort();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(value => { controller.signal.removeEventListener("abort", onAbort); resolve(value); }, error => { controller.signal.removeEventListener("abort", onAbort); reject(error); });
    });
    const authorize = async () => { await this.options.accountGuard?.assertCurrent(); this.options.accountGuard?.assertGenerationCurrent(); };
    try {
      await cancellable(authorize());
      this.options.assertActive?.();
      if (!light) {
        const sessionPromise = this.options.sessionFactory();
        // A cancelled asynchronous key load may complete after its caller has left.
        void sessionPromise.then(late => { if (controller.signal.aborted || generation !== this.generation) late.disconnect(); }, () => {});
        session = await cancellable(sessionPromise);
      }
      await cancellable(authorize());
      controller.signal.throwIfAborted();
      this.options.assertActive?.();
      this.options.accountGuard?.assertGenerationCurrent();
      client = (this.options.connect ?? mqtt.connect)(this.options.url, { username: this.options.username, password: this.options.password, reconnectPeriod: 0, queueQoSZero: false, clean: true, rejectUnauthorized: true, ...(this.options.tlsCa ? { ca: this.options.tlsCa } : {}), ...(this.options.tlsServername ? { servername: this.options.tlsServername } : {}) });
      this.current = { client, session };
      const connection = client;
      // MQTT errors may contain endpoint or credential details; never expose them.
      const failed = new Promise<never>((_, reject) => {
        connection.on("error", () => reject(new Error("Signed MQTT connection failed.")));
        connection.once("close", () => reject(new Error("Signed MQTT connection closed.")));
      });
      const wait = <T>(p: Promise<T>) => cancellable(Promise.race([p, failed]));
      await wait(new Promise<void>(resolve => connection.once("connect", () => resolve())));
      guard();
      if (light) {
        const payload = Buffer.from(JSON.stringify({system:{command:"ledctrl",led_node:light.light,led_mode:light.mode,led_on_time:500,led_off_time:500,loop_times:0,interval_time:0,sequence_id:String(Date.now())}}));
        await wait(authorize());
        guard();
        await wait(new Promise<void>((resolve, reject) => connection.publish(request, payload, {qos:1, retain:false}, error => error ? reject(new Error("Light MQTT publish failed; check printer status before retrying.")) : resolve())));
        return;
      }
      await wait(new Promise<void>((resolve, reject) => connection.subscribe(report, { qos: 1 }, (error, grants) => {
        if (error || !grants?.some(g => g.topic === report && g.qos !== 128)) reject(new Error("Signed MQTT subscription failed.")); else resolve();
      })));
      guard();
      let installPublishStarted = false;
      const installed = new Promise<void>((resolve, reject) => {
        connection.on("message", (topic, payload, packet) => {
          if (!installPublishStarted || topic !== report || !packet || packet.retain !== false) return;
          let reply: unknown;
          try { reply = JSON.parse(payload.toString("utf8")); } catch { return; }
          void session!.acceptInstallReply({ topic, generation, reply }).then(ok => {
            if (ok) resolve();
            else if (session!.readiness().state === "BLOCKED") reject(new Error("Signed control authentication failed."));
          }, () => reject(new Error("Signed control authentication failed.")));
        });
      });
      await wait(authorize());
      guard();
      const install = await wait(session!.beginInstall(generation));
      await wait(authorize());
      guard();
      await wait(new Promise<void>((resolve, reject) => {
        installPublishStarted = true;
        connection.publish(request, install.payload, { qos: 1, retain: false }, error => error ? reject(new Error("Signed MQTT installation publish failed.")) : resolve());
      }));
      await wait(installed);
      guard();
      const payload = await wait(session!.signCommand(command!));
      if (this.options.beforePublish) await wait(this.options.beforePublish());
      await wait(authorize());
      guard();
      await wait(new Promise<void>((resolve, reject) => {
        this.options.onPublish?.();
        connection.publish(request, payload, { qos: 1, retain: false }, error => error ? reject(new Error("Signed MQTT publish failed; check printer status before retrying.")) : resolve());
      }));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (this.current?.client === client) this.current = undefined;
      session?.disconnect();
      client?.end(true);
    }
  }
}

/** Parse the operator's explicit choice at the boundary. No connection occurs here. */
export function signedControlConfiguration(env: NodeJS.ProcessEnv, host: string, lanToken: string): undefined | {
  url: string; username: string; password: string; operatorPemDirectory: string; deviceCaFile: string; sequenceStore: string; localTlsCaFile?: string; localTlsServername?: string;
  accountGuard?: { assertCurrent(): Promise<void>; assertGenerationCurrent(): void };
} {
  const enabled = env.BAMBU_SIGNED_CONTROLS?.trim();
  if (!enabled || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error('BAMBU_SIGNED_CONTROLS must be true or false.');
  const operatorPemDirectory = env.BAMBU_SIGNING_DIR?.trim();
  const deviceCaFile = env.BAMBU_SIGNING_DEVICE_CA_FILE?.trim();
  const sequenceStore = env.BAMBU_SIGNING_STATE_DIR?.trim();
  if (!operatorPemDirectory || !deviceCaFile || !sequenceStore || ![operatorPemDirectory, deviceCaFile, sequenceStore].every(isAbsolute)) throw new Error('Signed control requires absolute paths for its signing directory, device CA file and initialized private state directory.');
  const route = env.BAMBU_SIGNED_WRITE_TRANSPORT?.trim();
  if (route === 'local') {
    if (!host || /[\s/@?#]/.test(host) || !lanToken) throw new Error('Signed local control requires a valid printer host and LAN access code.');
    const localTlsCaFile = env.BAMBU_SIGNED_LOCAL_TLS_CA_FILE?.trim();
    if (localTlsCaFile && !isAbsolute(localTlsCaFile)) throw new Error('Signed local TLS trust must use an absolute path.');
    const localTlsServername = env.BAMBU_SIGNED_LOCAL_TLS_SERVERNAME?.trim();
    if (localTlsServername && (isIP(localTlsServername) !== 0 || localTlsServername.length > 253 || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(localTlsServername))) throw new Error('Signed local TLS server name must be a DNS name.');
    return { url: `mqtts://${host}:8883`, username: 'bblp', password: lanToken, operatorPemDirectory, deviceCaFile, sequenceStore, localTlsCaFile, localTlsServername };
  }
  if (route === 'cloud') {
    const url = env.BAMBU_SIGNED_CLOUD_BROKER?.trim();
    const username = env.BAMBU_SIGNED_CLOUD_USERNAME?.trim();
    const password = env.BAMBU_SIGNED_CLOUD_TOKEN;
    if (!url || !username || !password) throw new Error('Signed cloud control requires a broker, account username and account token.');
    return { url, username, password, operatorPemDirectory, deviceCaFile, sequenceStore };
  }
  throw new Error('Select signed control transport local or cloud explicitly.');
}

/** A process-wide queue per printer prevents two independently-created writers racing. */
const printerQueues = new Map<string, Promise<unknown>>();
export async function sendSignedControl(config: NonNullable<ReturnType<typeof signedControlConfiguration>>, serial: string, command: CommandInput, signal?: AbortSignal, beforePublish?: () => Promise<void>, assertActive?: () => void, onPublish?: () => void): Promise<void> {
  return sendConfigured(config, serial, command, undefined, signal, beforePublish, assertActive, onPublish);
}
export async function sendTypedLight(config: NonNullable<ReturnType<typeof signedControlConfiguration>>, serial: string, light: string, mode: string, signal?: AbortSignal): Promise<void> {
  return sendConfigured(config, serial, undefined, {light, mode}, signal);
}
async function sendConfigured(
  config: NonNullable<ReturnType<typeof signedControlConfiguration>>, serial: string, command: CommandInput | undefined,
  light: {light:string; mode:string} | undefined, signal?: AbortSignal, beforePublish?: () => Promise<void>, assertActive?: () => void, onPublish?: () => void,
): Promise<void> {
  const previous = printerQueues.get(serial) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    await config.accountGuard?.assertCurrent();
    config.accountGuard?.assertGenerationCurrent();
    assertActive?.();
    const { open } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const { createSigningSession } = await import('./signing/index.js');
    let deviceTrustPem = "";
    if (!light) try {
      const file = await open(config.deviceCaFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024) throw new Error();
        const data = await file.readFile();
        if (!data.length || data.length > 128 * 1024) throw new Error();
        deviceTrustPem = data.toString('utf8');
      } finally { await file.close(); }
    } catch { throw new Error('Signed control device trust is unavailable or invalid.'); }
    let tlsCa: Buffer | undefined;
    if (config.localTlsCaFile) {
      try {
        const file = await open(config.localTlsCaFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024) throw new Error();
          tlsCa = await file.readFile();
          if (!tlsCa.length || tlsCa.length > 128 * 1024) throw new Error();
        } finally { await file.close(); }
      } catch { throw new Error('Signed control local TLS trust is unavailable or invalid.'); }
    }
    signal?.throwIfAborted();
    assertActive?.();
    const writer = new SignedTransport({ serial, url: config.url, username: config.username, password: config.password,
      sessionFactory: () => createSigningSession({ serial, operatorPemDirectory: config.operatorPemDirectory, deviceTrustPem, sequenceStore: config.sequenceStore }),
      beforePublish, assertActive, onPublish, tlsCa, tlsServername: config.localTlsServername, accountGuard: config.accountGuard,
    });
    if (light) await writer.sendLight(light.light, light.mode, signal);
    else await writer.send(command!, signal);
  });
  printerQueues.set(serial, work);
  try { await work; } finally { if (printerQueues.get(serial) === work) printerQueues.delete(serial); }
}

/** Opt-in selection also treats malformed values as selected so writes fail closed. */
export function signedControlsRequested(env: NodeJS.ProcessEnv): boolean {
  const value = env.BAMBU_SIGNED_CONTROLS?.trim();
  return Boolean(value && value !== 'false');
}

// The same inert manager backs explicit account tools and the opt-in cloud signer.
export const accountManager = new AccountManager();
export async function resolveSignedControlConfiguration(
  env: NodeJS.ProcessEnv, host: string, lanToken: string, serial: string,
  account: Pick<AccountManager, 'getCloudMqttCredentials'> = accountManager,
): Promise<ReturnType<typeof signedControlConfiguration>> {
  if (!signedControlsRequested(env) || env.BAMBU_SIGNED_WRITE_TRANSPORT?.trim() !== 'cloud') return signedControlConfiguration(env, host, lanToken);
  const provided = [env.BAMBU_SIGNED_CLOUD_BROKER?.trim(), env.BAMBU_SIGNED_CLOUD_USERNAME?.trim(), env.BAMBU_SIGNED_CLOUD_TOKEN];
  const count = provided.filter(Boolean).length;
  if (count === 3) return signedControlConfiguration(env, host, lanToken);
  if (count !== 0) throw new Error('Signed cloud credentials are incomplete; provide broker, username and token together.');
  if (env.BAMBU_SIGNED_CLOUD_AUTH?.trim() !== 'account') return signedControlConfiguration(env, host, lanToken);
  // Validate all non-account configuration before the first account request.
  signedControlConfiguration({...env, BAMBU_SIGNED_CLOUD_BROKER:'mqtts://placeholder.invalid', BAMBU_SIGNED_CLOUD_USERNAME:'placeholder', BAMBU_SIGNED_CLOUD_TOKEN:'placeholder'}, host, lanToken);
  const credentials = await account.getCloudMqttCredentials(serial);
  const config = signedControlConfiguration({...env, BAMBU_SIGNED_CLOUD_BROKER:credentials.url, BAMBU_SIGNED_CLOUD_USERNAME:credentials.username, BAMBU_SIGNED_CLOUD_TOKEN:credentials.password}, host, lanToken);
  if (!config) throw new Error('Signed control configuration is unavailable.');
  return { ...config, accountGuard: { assertCurrent: credentials.assertCurrent, assertGenerationCurrent: credentials.assertGenerationCurrent } };
}
