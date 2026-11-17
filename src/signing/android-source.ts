/** Extract only two identified strings from an operator-owned, hash-verified
 * Handy 4.4.1 APK. DEX evidence: generated SecretKeys map and IotCertConstants. */
import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, mkdir, rm, mkdtemp, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fingerprint, SigningError } from './pki.js';
const execute = promisify(execFile);
const APK_SHA256 = '88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506';
const BOOTSTRAP_SHA256 = '0711bdbef23b3f59dcb8eb3d6b04d0e0cb9d22425c4015b6c0a726eae1359ae3';
const WRAP_SHA256 = '2a5e9b8fd6a3b3642b5d9f4d1fd1cd354d0d5cb2caa76e66ed76f2bb97a6d5bb';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function strings(dex: Buffer): Buffer[] {
  if (dex.length < 112 || !/^dex\n0[0-9]{2}\0$/.test(dex.subarray(0, 8).toString('latin1')) || dex.readUInt32LE(32) !== dex.length || dex.readUInt32LE(40) !== 0x12345678) throw new Error();
  const count = dex.readUInt32LE(56), offset = dex.readUInt32LE(60);
  if (count > 2_000_000 || offset > dex.length || count * 4 > dex.length - offset) throw new Error();
  const result: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    let at = dex.readUInt32LE(offset + 4 * i), ended = false;
    if (at >= dex.length) throw new Error();
    for (let n = 0; n < 5; n++) { if (at >= dex.length) throw new Error(); if (!(dex[at++] & 0x80)) { ended = true; break; } }
    if (!ended) throw new Error();
    const end = dex.indexOf(0, at);
    if (end < 0 || end - at > 128 * 1024) throw new Error();
    // Only small ASCII bootstrap and PEM strings can match our hashes.
    if (end - at <= 8192) result.push(dex.subarray(at, end));
  }
  return result;
}
export async function extractHandyBootstrap(apk: string, directory: string): Promise<{ bootstrapFile: string; wrappingCertificateFile: string }> {
  let temporary: string | undefined, output: string | undefined;
  try {
    if (!isAbsolute(apk) || !isAbsolute(directory) || await realpath(directory) !== directory) throw new Error();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
    const file = await open(apk, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024 * 1024) throw new Error();
      bytes = await file.readFile();
      if (bytes.length !== info.size || sha(bytes) !== APK_SHA256) throw new Error();
    } finally { await file.close(); }
    temporary = await mkdtemp(join(directory, '.extract-'));
    const copy = join(temporary, 'package.apk');
    const fd = await open(copy, 'wx', 0o600); try { await fd.writeFile(bytes); } finally { await fd.close(); }
    const list = await execute('unzip', ['-Z', '-1', copy], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const entries = list.stdout.split('\n').filter(name => /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(name));
    if (!entries.includes('classes.dex') || entries.length > 100 || new Set(entries).size !== entries.length) throw new Error();
    const bootstraps: Buffer[] = [], certs: string[] = []; let total = 0;
    for (const entry of entries) {
      const result = await execute('unzip', ['-p', copy, entry], { encoding: 'buffer', timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
      const dex = result.stdout; total += dex.length;
      if (total > 512 * 1024 * 1024) throw new Error();
      for (const value of strings(dex)) {
        if (value.length <= 256 && sha(value) === BOOTSTRAP_SHA256) bootstraps.push(value);
        if (value.subarray(0, 27).toString('ascii') === '-----BEGIN CERTIFICATE-----') {
          try { const pem = value.toString('utf8'); if (fingerprint(new X509Certificate(pem)) === WRAP_SHA256) certs.push(pem); } catch { /* unrelated DEX string */ }
        }
      }
    }
    if (new Set(bootstraps.map(value => value.toString('hex'))).size !== 1 || new Set(certs).size !== 1) throw new Error();
    output = await mkdtemp(join(directory, 'source-'));
    const write = async (name: string, value: Buffer | string) => { const f = await open(join(output!, name), 'wx', 0o600); try { await f.writeFile(value); await f.sync(); } finally { await f.close(); } };
    await write('bootstrap', bootstraps[0]); await write('wrapping-cert.pem', certs[0]);
    const result = { bootstrapFile: join(output, 'bootstrap'), wrappingCertificateFile: join(output, 'wrapping-cert.pem') };
    output = undefined; return result;
  } catch { throw new SigningError('SIGNING_HANDY_SOURCE_EXTRACTION_FAILED'); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); if (output) await rm(output, { recursive: true, force: true }); }
}
