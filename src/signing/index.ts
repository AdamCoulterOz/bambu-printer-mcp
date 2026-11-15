import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { APP_CA_SHA256, checkOpenSsl, fail, SigningError, validateAppMaterial, validateDeviceTrust } from './pki.js';
import { SequenceStore } from './sequence.js';
import { SigningSession } from './session.js';
export { SigningSession } from './session.js';
export type { ConnectionGeneration, SigningReadiness, CommandInput } from './session.js';
export { SigningError } from './pki.js';
export type SigningOptions = {
  serial: string;
  operatorPemDirectory: string;
  /** Independent vendor device trust CA bundle contents; never the app CA. */
  deviceTrustPem: string;
  /** Absolute private directory initialized by signing-setup. Stable across key rotation. */
  sequenceStore?: string;
  /** Trusted internal clock in Unix epoch milliseconds. */
  clock?: () => number;
};
async function readOperatorFile(path: string, privateKey = false): Promise<string> {
  try {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      if (!st.isFile() || st.size <= 0 || st.size > 128 * 1024 || (privateKey && (st.uid !== process.getuid?.() || (st.mode & 0o077)))) return fail('SIGNING_OPERATOR_PEM_INVALID');
      const data = await fd.readFile('utf8');
      if (Buffer.byteLength(data) > 128 * 1024) return fail('SIGNING_OPERATOR_PEM_INVALID');
      return data;
    } finally { await fd.close(); }
  } catch { return fail('SIGNING_OPERATOR_PEM_INVALID'); }
}
export async function createSigningSession(options: SigningOptions): Promise<SigningSession> {
  try {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(options.serial) || !isAbsolute(options.operatorPemDirectory)) return fail('SIGNING_CONFIGURATION_INVALID');
    const directory = await lstat(options.operatorPemDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return fail('SIGNING_OPERATOR_PEM_INVALID');
    validateDeviceTrust(options.deviceTrustPem); // Independent explicit trust is mandatory.
    await checkOpenSsl();
    const now = (options.clock ?? Date.now)();
    if (!Number.isFinite(now) || now < 0) return fail('SIGNING_CLOCK_INVALID');
    const key = await readOperatorFile(join(options.operatorPemDirectory, 'slicer_key.pem'), true);
    const chain = await readOperatorFile(join(options.operatorPemDirectory, 'slicer_cert.pem'));
    const crl = await readOperatorFile(join(options.operatorPemDirectory, 'slicer_crl.pem'));
    const app = await validateAppMaterial(key, chain, crl, now, APP_CA_SHA256);
    const sequences = new SequenceStore(options.sequenceStore); await sequences.check();
    return new SigningSession(options.serial, app, options.deviceTrustPem, sequences, options.clock);
  } catch (error) {
    if (error instanceof SigningError) throw error;
    return fail('SIGNING_CONFIGURATION_INVALID');
  }
}
