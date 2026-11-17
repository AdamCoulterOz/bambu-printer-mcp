/** HTTP task proof; protocol facts: open-bamboo-networking 77de55a8c696c53125ca297bdf3fdf1258772335, research/10.05-http-pop.md. */
import { constants as cryptoConstants, privateEncrypt, randomUUID, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ensureManagedSigningCredentials, resolveSigningDirectory, type AutoRenewSigningOptions } from './bootstrap.js';
import { APP_CA_SHA256, certificateId, checkOpenSsl, fail, pemBlocks, validateAppMaterial } from './pki.js';

async function read(path: string, secret = false): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 128 * 1024 || (secret && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) return fail('SIGNING_OPERATOR_PEM_INVALID');
    const value = await fd.readFile('utf8');
    if (Buffer.byteLength(value) > 128 * 1024) return fail('SIGNING_OPERATOR_PEM_INVALID');
    return value;
  } finally { await fd.close(); }
}

/** Parse explicit configuration without reading files or contacting the network. */
export function httpProofRenewalConfiguration(env: NodeJS.ProcessEnv, directory: string): AutoRenewSigningOptions | undefined {
  const value = env.BAMBU_SIGNING_AUTO_RENEW?.trim();
  if (!value || value === 'false') return undefined;
  if (value !== 'true' || !isAbsolute(directory)) return fail('SIGNING_CONFIGURATION_INVALID');
  const region = env.BAMBU_SIGNING_REGION?.trim();
  const bootstrapFile = env.BAMBU_SIGNING_BOOTSTRAP_FILE?.trim(), wrappingCertificateFile = env.BAMBU_SIGNING_WRAPPING_CERTIFICATE_FILE?.trim();
  if ((region !== 'global' && region !== 'cn') || Boolean(bootstrapFile) !== Boolean(wrappingCertificateFile) || (bootstrapFile && !isAbsolute(bootstrapFile)) || (wrappingCertificateFile && !isAbsolute(wrappingCertificateFile))) return fail('SIGNING_CONFIGURATION_INVALID');
  return { directory, region, bootstrapFile, wrappingCertificateFile };
}

/** Creates short-lived proof only after validating key, certificate and CRL. Never expose to MCP callers. */
export async function createHttpProof(directory: string, clock: () => number = Date.now, autoRenew?: AutoRenewSigningOptions): Promise<Record<string, string>> {
  if (!isAbsolute(directory) || (autoRenew && autoRenew.directory !== directory)) return fail('SIGNING_CONFIGURATION_INVALID');
  if (autoRenew) await ensureManagedSigningCredentials(autoRenew);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('SIGNING_OPERATOR_PEM_INVALID');
  const resolved = await resolveSigningDirectory(directory);
  const [key, chain, crl] = await Promise.all([read(join(resolved, 'slicer_key.pem'), true), read(join(resolved, 'slicer_cert.pem')), read(join(resolved, 'slicer_crl.pem'))]);
  await checkOpenSsl();
  const now = clock();
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(String(now))) return fail('SIGNING_CLOCK_INVALID');
  const material = await validateAppMaterial(key, chain, crl, now, APP_CA_SHA256);
  const leaf = new X509Certificate(pemBlocks(chain, 'CERTIFICATE')[0]);
  const serial = leaf.serialNumber.toLowerCase().replace(/^0+/, '');
  const mqttId = certificateId(leaf);
  if (!serial || !mqttId.startsWith(serial)) return fail('SIGNING_CERT_INVALID');
  const id = `${mqttId.slice(serial.length)}:${serial}`;
  const proof = privateEncrypt({ key: material.privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(String(now))).toString('base64');
  return { 'x-bbl-app-certification-id': id, 'x-bbl-device-security-sign': proof };
}

/** Android Handy 4.4.1 (APK SHA-256 88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506),
 * BblHeaderInterceptor.java:175-199; device identity is application-owned. */
export async function handyClientHeaders(stateDirectory: string, osVersion: string): Promise<Record<string, string>> {
  if (!isAbsolute(stateDirectory) || !/^[A-Za-z0-9 ._-]{1,64}$/.test(osVersion)) return fail('SIGNING_CONFIGURATION_INVALID');
  const dir = await lstat(stateDirectory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) return fail('SIGNING_OPERATOR_PEM_INVALID');
  const target = join(stateDirectory, 'handy-device-id');
  const temporary = join(stateDirectory, `.handy-device-id-${randomUUID()}`);
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(`${randomUUID()}\n`); await fd.sync(); } finally { await fd.close(); }
  try { try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  finally { await unlink(temporary); }
  const deviceId = (await read(target, true)).trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deviceId)) return fail('SIGNING_CONFIGURATION_INVALID');
  return {'user-agent':'Handy/4.4.1','x-bbl-client-type':'app','x-bbl-client-name':'BambuHandy','x-bbl-client-version':'4.4.1','x-bbl-client-release-code':'40401','x-bbl-os-type':'android','x-bbl-os-version':osVersion,'x-bbl-device-brand':'headless-runtime','x-bbl-device-model':'headless-runtime','x-bbl-language':'en-US','x-bbl-device-id':deviceId};
}
