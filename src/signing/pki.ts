/** Independent X.509 boundary. Path, constraints, signatures and CRLs are checked
 * by OpenSSL 3+, never by treating Node's X509Certificate parser as a verifier.
 * App trust ends at the fixed directly issuing CA; its upstream revocation is
 * deliberately not claimed. Device trust is a separate operator supplied CA.
 */
import { X509Certificate, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

export const APP_CA_SHA256 = '0569df45e97c9e5b3ea1eaa0c73b0d1f65f33579f1542870ec5845a134747978';
export class SigningError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'SigningError'; }
}
export const fail = (code: string): never => { throw new SigningError(code); };
const MAX_PEM = 128 * 1024;
// Trust bundles include current and legacy vendor CAs; certificate chains retain
// their independent six-certificate bound. The byte limit applies to both.
const MAX_DEVICE_TRUST_CERTIFICATES = 8;
export function pemBlocks(input: string, label: 'CERTIFICATE' | 'X509 CRL', maximum = 6): string[] {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_PEM) return fail('SIGNING_PEM_INVALID');
  const pattern = new RegExp(`-----BEGIN ${label}-----[\\r\\n]+[A-Za-z0-9+/=\\r\\n]+-----END ${label}-----`, 'g');
  const blocks = input.match(pattern) ?? [];
  if (!blocks.length || blocks.length > maximum || input.replace(pattern, '').trim()) return fail('SIGNING_PEM_INVALID');
  return blocks.map(block => block + '\n');
}
function cert(pem: string): X509Certificate {
  try { return new X509Certificate(pem); } catch { return fail('SIGNING_CERT_INVALID'); }
}
export function fingerprint(certificate: X509Certificate): string { return certificate.fingerprint256.replace(/:/g, '').toLowerCase(); }
function rsa(key: KeyObject): void {
  const n = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== 'rsa' || !n || n < 2048 || n > 8192) fail('SIGNING_RSA_REQUIRED');
}
function validUntil(certificate: X509Certificate, now: number): number {
  const start = Date.parse(certificate.validFrom), end = Date.parse(certificate.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) fail('SIGNING_CERT_EXPIRED_OR_NOT_YET_VALID');
  return end;
}
async function openssl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: '/dev/null' } }, (error, stdout) => {
      if (error) reject(new SigningError('SIGNING_PKI_VERIFICATION_FAILED')); else resolve(stdout);
    });
  });
}
export async function checkOpenSsl(): Promise<void> {
  const version = await openssl(['version']);
  if (!/^OpenSSL (?:[3-9]|[1-9]\d+)\./.test(version)) fail('SIGNING_OPENSSL_3_REQUIRED');
}
async function workspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bambu-signing-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function put(dir: string, name: string, text: string): Promise<string> {
  const path = join(dir, name); await writeFile(path, text, { mode: 0o600, flag: 'wx' }); return path;
}
const verifyArgs = (now: number): string[] => ['verify', '-no-CAfile', '-no-CApath', '-no-CAstore', '-x509_strict', '-auth_level', '2', '-purpose', 'any', '-partial_chain', '-attime', String(Math.floor(now / 1000))];

// Small bounded DER reader used only for unambiguous RFC4514 names/keyUsage.
// OpenSSL is still responsible for full certificate validity and extension semantics.
type Der = { tag: number; value: Buffer; raw: Buffer };
function children(input: Buffer): Der[] {
  const result: Der[] = [];
  for (let offset = 0; offset < input.length;) {
    const start = offset, tag = input[offset++];
    if ((tag & 31) === 31 || offset >= input.length) return fail('SIGNING_DN_UNSUPPORTED');
    let length = input[offset++];
    if (length & 128) {
      const count = length & 127;
      if (!count || count > 4 || offset + count > input.length || input[offset] === 0) return fail('SIGNING_DN_UNSUPPORTED');
      length = 0; for (let i = 0; i < count; i++) length = length * 256 + input[offset++];
      if (length < 128) return fail('SIGNING_DN_UNSUPPORTED');
    }
    if (offset + length > input.length) return fail('SIGNING_DN_UNSUPPORTED');
    result.push({ tag, value: input.subarray(offset, offset + length), raw: input.subarray(start, offset + length) });
    offset += length;
    if (result.length > 256) return fail('SIGNING_DN_UNSUPPORTED');
  }
  return result;
}
function oid(data: Buffer): string {
  if (!data.length) return fail('SIGNING_DN_UNSUPPORTED');
  const values: bigint[] = []; let n = 0n;
  for (const byte of data) { n = n * 128n + BigInt(byte & 127); if (n > (1n << 63n)) return fail('SIGNING_DN_UNSUPPORTED'); if (!(byte & 128)) { values.push(n); n = 0n; } }
  if ((data[data.length - 1] & 128) || !values.length) return fail('SIGNING_DN_UNSUPPORTED');
  const first = values.shift()!; const a = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [a, first - a * 40n, ...values].join('.');
}
const names: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber', '0.9.2342.19200300.100.1.25': 'DC', '0.9.2342.19200300.100.1.1': 'UID' };
function stringValue(der: Der): string {
  try {
    if (der.tag === 12) return new TextDecoder('utf-8', { fatal: true }).decode(der.value);
    if ([19, 22].includes(der.tag) && der.value.every(byte => byte > 0 && byte < 128)) return der.value.toString('ascii');
  } catch { /* reject malformed UTF-8 */ }
  return fail('SIGNING_DN_UNSUPPORTED');
}
function escapeName(value: string): string {
  return [...value].map((char, index, chars) => {
    if (char === '\0') return '\\00';
    if (',+"\\<>;'.includes(char) || (index === 0 && (char === ' ' || char === '#')) || (index === chars.length - 1 && char === ' ')) return '\\' + char;
    if (char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) return [...Buffer.from(char)].map(b => '\\' + b.toString(16).padStart(2, '0')).join('');
    return char;
  }).join('');
}
export function rfc4514(name: Der): string {
  if (name.tag !== 48) return fail('SIGNING_DN_UNSUPPORTED');
  return children(name.value).reverse().map(set => {
    if (set.tag !== 49) return fail('SIGNING_DN_UNSUPPORTED');
    const values = children(set.value);
    if (!values.length) return fail('SIGNING_DN_UNSUPPORTED');
    return values.map(ava => {
      if (ava.tag !== 48) return fail('SIGNING_DN_UNSUPPORTED');
      const pair = children(ava.value);
      if (pair.length !== 2 || pair[0].tag !== 6) return fail('SIGNING_DN_UNSUPPORTED');
      const id = oid(pair[0].value), short = names[id];
      return short ? `${short}=${escapeName(stringValue(pair[1]))}` : `${id}=#${pair[1].raw.toString('hex')}`;
    }).join('+');
  }).join(',');
}
function certificateParts(certificate: X509Certificate): { tbs: Der[]; issuer: Der; subject: Der; serial: Der } {
  const outer = children(certificate.raw);
  if (outer.length !== 1 || outer[0].tag !== 48) return fail('SIGNING_CERT_INVALID');
  const full = children(outer[0].value), tbs = children(full[0].value);
  const shift = tbs[0].tag === 160 ? 1 : 0;
  if (tbs.length < shift + 6 || tbs[shift].tag !== 2) return fail('SIGNING_CERT_INVALID');
  return { tbs, serial: tbs[shift], issuer: tbs[shift + 2], subject: tbs[shift + 4] };
}
export function certificateId(certificate: X509Certificate): string {
  const { serial, issuer } = certificateParts(certificate);
  if (serial.value[0] & 128) return fail('SIGNING_CERT_INVALID');
  const hex = serial.value.toString('hex').replace(/^0+/, '');
  if (!hex || /^0+$/.test(hex)) return fail('SIGNING_CERT_INVALID');
  return hex + rfc4514(issuer);
}
function commonNames(certificate: X509Certificate): string[] {
  const { subject } = certificateParts(certificate);
  return children(subject.value).flatMap(set => children(set.value).flatMap(ava => {
    const pair = children(ava.value); return pair.length === 2 && oid(pair[0].value) === '2.5.4.3' ? [stringValue(pair[1])] : [];
  }));
}
function requireUsage(certificate: X509Certificate, mask: number): void {
  const { tbs } = certificateParts(certificate);
  const extensions = tbs.filter(part => part.tag === 163);
  if (extensions.length !== 1) return fail('SIGNING_KEY_USAGE_REQUIRED');
  const sequence = children(extensions[0].value);
  const matches = children(sequence[0].value).filter(extension => oid(children(extension.value)[0].value) === '2.5.29.15');
  if (matches.length !== 1) return fail('SIGNING_KEY_USAGE_REQUIRED');
  const parts = children(matches[0].value), value = parts[parts.length - 1];
  if (value.tag !== 4) return fail('SIGNING_KEY_USAGE_REQUIRED');
  const bits = children(value.value);
  if (bits.length !== 1 || bits[0].tag !== 3 || bits[0].value.length < 2 || !(bits[0].value[1] & mask)) fail('SIGNING_KEY_USAGE_REQUIRED');
}
export type AppMaterial = { privateKey: KeyObject; certId: string; chainPem: string; crlPem: string; notBefore: number; expiresAt: number };
/** Internal verifier accepts an explicit pin so synthetic PKI can exercise every
 * gate. The production factory always supplies APP_CA_SHA256, never user input. */
export async function validateAppMaterial(keyPem: string, chainPem: string, crlPem: string, now: number, expectedPin: string): Promise<AppMaterial> {
  const pems = pemBlocks(chainPem, 'CERTIFICATE'), certificates = pems.map(cert);
  const crls = pemBlocks(crlPem, 'X509 CRL', 1);
  if (certificates.length < 2 || certificates.filter(c => fingerprint(c) === expectedPin).length !== 1 || fingerprint(certificates[1]) !== expectedPin) fail('SIGNING_APP_CA_PIN_MISMATCH');
  const leaf = certificates[0], anchor = certificates[1];
  if (leaf.ca || !anchor.ca || !leaf.checkIssued(anchor)) fail('SIGNING_APP_CHAIN_UNSUPPORTED');
  // Extra supplied ancestors are preserved for provisioning, never trust inputs.
  // They must be a strictly linked CA tail; verification terminates at our pin.
  for (let i = 2; i < certificates.length; i++) {
    if (!certificates[i].ca || !certificates[i - 1].checkIssued(certificates[i]) || !certificates[i - 1].verify(certificates[i].publicKey)) fail('SIGNING_APP_CHAIN_UNSUPPORTED');
  }
  let expiresAt = Math.min(...certificates.map(c => validUntil(c, now)));
  let notBefore = Math.max(...certificates.map(c => Date.parse(c.validFrom)));
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey(keyPem); } catch { return fail('SIGNING_PRIVATE_KEY_INVALID'); }
  rsa(privateKey); rsa(leaf.publicKey); requireUsage(leaf, 128);
  if (!createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(leaf.publicKey.export({ type: 'spki', format: 'der' }))) fail('SIGNING_KEY_CERT_MISMATCH');
  await workspace(async dir => {
    const ca = await put(dir, 'ca.pem', pems[1]), leafPath = await put(dir, 'leaf.pem', pems[0]), crl = await put(dir, 'crl.pem', crls[0]);
    const dates = await openssl(['crl', '-in', crl, '-noout', '-lastupdate', '-nextupdate']);
    const last = Date.parse(dates.match(/^lastUpdate=(.+)$/m)?.[1] ?? ''), next = Date.parse(dates.match(/^nextUpdate=(.+)$/m)?.[1] ?? '');
    if (!Number.isFinite(last) || !Number.isFinite(next) || now < last || now >= next || next <= last) fail('SIGNING_CRL_STALE_OR_INVALID');
    expiresAt = Math.min(expiresAt, next); notBefore = Math.max(notBefore, last);
    await openssl([...verifyArgs(now), '-trusted', ca, '-CRLfile', crl, '-crl_check', leafPath]);
    if (pems.length > 2) {
      const tailRoot = await put(dir, 'tail-root.pem', pems[pems.length - 1]);
      // This upload-only ancestry lies ABOVE the immutable app trust pin.
      // Legacy ancestors can omit SKI. Keep normal CA/signature/path/time/
      // critical-extension checks here; strict pinned app/CRL and device
      // verification above/below are unchanged.
      const tailArgs = [...verifyArgs(now).filter(argument => argument !== '-x509_strict'), '-trusted', tailRoot];
      if (pems.length > 3) tailArgs.push('-untrusted', await put(dir, 'tail.pem', pems.slice(2, -1).join('')));
      // Consistency only: this does not replace the independent pinned-leaf check.
      await openssl([...tailArgs, ca]);
    }
  });
  return { privateKey, certId: certificateId(leaf), chainPem: pems.join(''), crlPem: crls[0], notBefore, expiresAt };
}
export function validateDeviceTrust(trustPem: string): void {
  const trust = pemBlocks(trustPem, 'CERTIFICATE', MAX_DEVICE_TRUST_CERTIFICATES).map(cert);
  if (trust.some(c => !c.ca || fingerprint(c) === APP_CA_SHA256) || new Set(trust.map(fingerprint)).size !== trust.length) fail('SIGNING_DEVICE_TRUST_INVALID');
}
export type DeviceMaterial = { publicKey: KeyObject; notBefore: number; expiresAt: number };
export async function validateDeviceMaterial(chainPem: string, trustPem: string, serial: string, now: number): Promise<DeviceMaterial> {
  const pems = pemBlocks(chainPem, 'CERTIFICATE'), certificates = pems.map(cert), trust = pemBlocks(trustPem, 'CERTIFICATE', MAX_DEVICE_TRUST_CERTIFICATES);
  const leaf = certificates[0];
  if (leaf.ca || commonNames(leaf).length !== 1 || commonNames(leaf)[0] !== serial) fail('SIGNING_DEVICE_IDENTITY_MISMATCH');
  if (trust.map(cert).some(c => !c.ca)) fail('SIGNING_DEVICE_TRUST_INVALID');
  rsa(leaf.publicKey); requireUsage(leaf, 32);
  const expiresAt = Math.min(...[...certificates, ...trust.map(cert)].map(c => validUntil(c, now)));
  await workspace(async dir => {
    const ca = await put(dir, 'trust.pem', trust.join('')), leafPath = await put(dir, 'leaf.pem', pems[0]);
    const args = [...verifyArgs(now), '-trusted', ca];
    if (pems.length > 1) args.push('-untrusted', await put(dir, 'chain.pem', pems.slice(1).join('')));
    await openssl([...args, leafPath]);
  });
  return { publicKey: leaf.publicKey, notBefore: Math.max(...[...certificates, ...trust.map(cert)].map(c => Date.parse(c.validFrom))), expiresAt };
}
