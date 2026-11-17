import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHandyBootstrap } from '../dist/signing/android-source.js';
import { provisionSigningCredentials, resolveSigningDirectory, ensureManagedSigningCredentials } from '../dist/signing/bootstrap.js';
import { signedControlConfiguration } from '../dist/signing-transport.js';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'signing-bootstrap-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('managed pointer selects a complete immutable directory and rejects malformed or unsafe state', async t => {
  const dir = await fixture(t), generation = 'generation-' + 'a'.repeat(32);
  assert.equal(await resolveSigningDirectory(dir), dir);
  await mkdir(join(dir, generation), { mode: 0o700 });
  await writeFile(join(dir, 'current'), generation + '\n', { mode: 0o600 });
  assert.equal(await resolveSigningDirectory(dir), join(dir, generation));
  await writeFile(join(dir, 'current'), '../escape\n');
  await assert.rejects(resolveSigningDirectory(dir), /SIGNING_MANAGED_DIRECTORY_INVALID/);
  await writeFile(join(dir, 'current'), generation + '\n'); await chmod(join(dir, 'current'), 0o644);
  await assert.rejects(resolveSigningDirectory(dir), /SIGNING_BOOTSTRAP_INPUT_INVALID/);
});
test('failed issuance releases the OS lock, preserves current generation and rate limits automatic retries', async t => {
  const dir = await fixture(t), generation = 'generation-' + 'b'.repeat(32);
  await mkdir(join(dir, generation), { mode: 0o700 });
  await writeFile(join(dir, 'current'), generation + '\n', { mode: 0o600 });
  const options = { directory: dir, bootstrapFile: join(dir, 'missing'), wrappingCertificateFile: join(dir, 'missing-cert'), region: 'global' };
  await assert.rejects(provisionSigningCredentials(options), /SIGNING_ISSUANCE_FAILED/);
  await assert.rejects(provisionSigningCredentials(options), /SIGNING_ISSUANCE_FAILED/);
  assert.equal(await readFile(join(dir, 'current'), 'utf8'), generation + '\n');
  await assert.rejects(ensureManagedSigningCredentials(options), /SIGNING_ISSUANCE_FAILED/);
  await assert.rejects(ensureManagedSigningCredentials(options), /SIGNING_RENEWAL_THROTTLED/);
});
test('unverified APK is rejected without creating a source or exposing contents', async t => {
  const dir = await fixture(t), apk = join(dir, 'input.apk');
  await writeFile(apk, 'synthetic', { mode: 0o600 });
  await assert.rejects(extractHandyBootstrap(apk, dir), /SIGNING_HANDY_SOURCE_EXTRACTION_FAILED/);
});
test('automatic renewal is explicit and requires a complete private configuration', () => {
  const base = { BAMBU_SIGNED_CONTROLS: 'true', BAMBU_SIGNED_WRITE_TRANSPORT: 'cloud', BAMBU_SIGNING_DIR: '/private/material', BAMBU_SIGNING_DEVICE_CA_FILE: '/private/ca', BAMBU_SIGNING_STATE_DIR: '/private/sequence', BAMBU_SIGNED_CLOUD_BROKER: 'mqtts://example.invalid', BAMBU_SIGNED_CLOUD_USERNAME: 'user', BAMBU_SIGNED_CLOUD_TOKEN: 'token' };
  assert.equal(signedControlConfiguration(base, '', '').autoRenew, undefined);
  assert.throws(() => signedControlConfiguration({ ...base, BAMBU_SIGNING_AUTO_RENEW: 'true' }, '', ''), /Automatic signing renewal requires/);
  const managed = signedControlConfiguration({ ...base, BAMBU_SIGNING_AUTO_RENEW: 'true', BAMBU_SIGNING_REGION: 'global' }, '', '');
  assert.equal(managed.autoRenew.directory, '/private/material');
  assert.equal(managed.autoRenew.bootstrapFile, undefined);
  assert.throws(() => signedControlConfiguration({ ...base, BAMBU_SIGNING_AUTO_RENEW: 'true', BAMBU_SIGNING_REGION: 'global', BAMBU_SIGNING_BOOTSTRAP_FILE: '/private/bootstrap' }, '', ''), /Automatic signing renewal requires/);
  const config = signedControlConfiguration({ ...base, BAMBU_SIGNING_AUTO_RENEW: 'true', BAMBU_SIGNING_BOOTSTRAP_FILE: '/private/bootstrap', BAMBU_SIGNING_WRAPPING_CERTIFICATE_FILE: '/private/cert', BAMBU_SIGNING_REGION: 'global' }, '', '');
  assert.equal(config.autoRenew.directory, '/private/material');
});

test('issuance wire framing and authenticated response decrypt with synthetic keys', async () => {
  const { generateKeyPairSync, randomBytes, privateDecrypt, constants, createDecipheriv, createCipheriv } = await import('node:crypto');
  const { encodeCredentialRequest, decryptCredentialKey } = await import('../dist/signing/bootstrap.js');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const aes = randomBytes(32), iv = randomBytes(12);
  const { encrypted, wrapped } = encodeCredentialRequest('synthetic', publicKey, aes, iv);
  assert.deepEqual(privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, wrapped), aes);
  const decipher = createDecipheriv('aes-256-gcm', aes, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString(), 'GLOF3813734089-synthetic');
  const cipher = createCipheriv('aes-256-gcm', aes, iv);
  const reply = Buffer.concat([iv, cipher.update('synthetic-private-key'), cipher.final(), cipher.getAuthTag()]);
  assert.equal(decryptCredentialKey(reply.toString('base64'), aes).toString(), 'synthetic-private-key');
  reply[reply.length - 1] ^= 1;
  assert.throws(() => decryptCredentialKey(reply.toString('base64'), aes));
});

async function issuanceFixture(t) {
  const { execFileSync } = await import('node:child_process');
  const { X509Certificate } = await import('node:crypto');
  const { fingerprint } = await import('../dist/signing/pki.js');
  const dir = await fixture(t), privateFile = async (name, value) => writeFile(join(dir, name), value, { mode: 0o600 });
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  await mkdir(join(dir, 'newcerts')); await privateFile('index.txt', ''); await privateFile('serial', '1001'); await privateFile('crlnumber', '1001');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Synthetic Issuer', '-addext', 'basicConstraints=critical,CA:true,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash');
  await privateFile('ca.cnf', `[ca]\ndefault_ca=main\n[main]\ndir=${dir}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/newcerts\ncertificate=$dir/ca.pem\nprivate_key=$dir/ca.key\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\ndefault_days=10\ndefault_crl_days=5\npolicy=policy\n[policy]\ncommonName=supplied\n[app]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n`);
  openssl('req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'app.key', '-out', 'app.csr', '-subj', '/CN=Synthetic App');
  openssl('ca', '-batch', '-notext', '-config', 'ca.cnf', '-extensions', 'app', '-in', 'app.csr', '-out', 'app.pem');
  openssl('ca', '-gencrl', '-config', 'ca.cnf', '-out', 'valid.crl');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'wrap.key', '-out', 'wrap.pem', '-days', '10', '-subj', '/CN=Synthetic Wrap');
  const ca = await readFile(join(dir, 'ca.pem'), 'utf8'), app = await readFile(join(dir, 'app.pem'), 'utf8');
  const key = await readFile(join(dir, 'app.key')), crl = await readFile(join(dir, 'valid.crl'), 'utf8'), wrap = await readFile(join(dir, 'wrap.pem'), 'utf8');
  await chmod(join(dir, 'wrap.pem'), 0o600); await privateFile('bootstrap', 'synthetic');
  return { dir, key, crl, cert: app + ca, wrapKey: await readFile(join(dir, 'wrap.key')), options: { directory: dir, bootstrapFile: join(dir, 'bootstrap'), wrappingCertificateFile: join(dir, 'wrap.pem'), region: 'global' }, pins: { appPin: fingerprint(new X509Certificate(ca)), wrapPin: fingerprint(new X509Certificate(wrap)), clock: Date.now } };
}
async function fakeIssuance(f, url, changes = {}) {
  const { privateDecrypt, constants, createDecipheriv, createCipheriv, randomBytes } = await import('node:crypto');
  assert.equal(url.origin, 'https://api.bambulab.com');
  const key = privateDecrypt({ key: f.wrapKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(url.searchParams.get('aes256'), 'base64url'));
  const encrypted = Buffer.from(url.pathname.split('/').at(-2), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12)); decipher.setAuthTag(encrypted.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString(), 'GLOF3813734089-synthetic');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const blob = Buffer.concat([iv, cipher.update(f.key), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(JSON.stringify({ code: 0, cert: f.cert, key: blob.toString('base64'), crl: [f.crl], ...changes }));
}
test('synthetic fixed-host issuance publishes complete generation and rejects invalid replacements', async t => {
  const { provisionSigningCredentialsForTest } = await import('../dist/signing/bootstrap.js');
  const f = await issuanceFixture(t);
  const dependencies = { ...f.pins, request: url => fakeIssuance(f, url) };
  const result = await provisionSigningCredentialsForTest(f.options, false, dependencies);
  assert.ok(Date.parse(result.expiresAt) > Date.now());
  const previous = await readFile(join(f.dir, 'current'), 'utf8');
  const active = await resolveSigningDirectory(f.dir);
  assert.match(await readFile(join(active, 'slicer_key.pem'), 'utf8'), /BEGIN PRIVATE KEY/);
  assert.equal(await readFile(join(active, 'slicer_cert.pem'), 'utf8'), f.cert);
  assert.equal((await readFile(join(active, 'slicer_crl.pem'), 'utf8')).trim(), f.crl.trim());
  for (const changes of [{ cert: 'invalid' }, { crl: ['invalid'] }]) {
    await assert.rejects(provisionSigningCredentialsForTest(f.options, false, { ...dependencies, request: url => fakeIssuance(f, url, changes) }));
    assert.equal(await readFile(join(f.dir, 'current'), 'utf8'), previous);
  }
});
test('cooperating issuance calls serialize through publication', async t => {
  const { provisionSigningCredentialsForTest } = await import('../dist/signing/bootstrap.js');
  const f = await issuanceFixture(t); let active = 0, maximum = 0, calls = 0;
  const deps = { ...f.pins, request: async url => { calls++; active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 150)); const result = await fakeIssuance(f, url); active--; return result; } };
  await Promise.all([provisionSigningCredentialsForTest(f.options, false, deps), provisionSigningCredentialsForTest(f.options, false, deps)]);
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.match(await readFile(join(f.dir, 'current'), 'utf8'), /^generation-[a-f0-9]{32}\n$/);
});
test('process death releases held OS issuance lock', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { provisionSigningCredentialsForTest } = await import('../dist/signing/bootstrap.js');
  const f = await issuanceFixture(t);
  const moduleUrl = new URL('../dist/signing/bootstrap.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireSigningLockForTest } from ${JSON.stringify(moduleUrl)}; await acquireSigningLockForTest(process.argv[1]); console.log('ready'); setInterval(()=>{},1000);`, f.dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const [ready] = await once(child.stdout, 'data'); assert.equal(ready.toString().trim(), 'ready');
  child.kill('SIGKILL'); await once(child, 'exit');
  await provisionSigningCredentialsForTest(f.options, false, { ...f.pins, request: url => fakeIssuance(f, url) });
  assert.match(await readFile(join(f.dir, 'current'), 'utf8'), /^generation-/);
});
test('overall response deadline survives request close and continuous body activity', async () => {
  const { EventEmitter } = await import('node:events');
  const { requestCredentialForTest } = await import('../dist/signing/bootstrap.js');
  let destroyed = false;
  const transport = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed = true; req.emit('error', new Error('closed')); };
    const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => {}; response.resume = () => {};
    queueMicrotask(() => { callback(response); req.emit('close'); const interval = setInterval(() => response.emit('data', Buffer.from('x')), 5); setTimeout(() => clearInterval(interval), 150); });
    return req;
  };
  const started = Date.now();
  await assert.rejects(requestCredentialForTest(new URL('https://example.invalid'), transport, 50), /SIGNING_ISSUANCE_FAILED/);
  assert.equal(destroyed, true); assert.ok(Date.now() - started < 500);
});

test('managed source follows the active generation through on-demand renewal', async t => {
  const { provisionSigningCredentialsForTest, ensureManagedSigningCredentialsForTest } = await import('../dist/signing/bootstrap.js');
  const f = await issuanceFixture(t); let calls = 0;
  const deps = { ...f.pins, request: url => { calls++; return fakeIssuance(f, url); } };
  await provisionSigningCredentialsForTest({ ...f.options, persistSource: true }, false, deps);
  const first = await resolveSigningDirectory(f.dir);
  assert.equal(await readFile(join(first, 'source-bootstrap'), 'utf8'), 'synthetic');
  await ensureManagedSigningCredentialsForTest({ directory: f.dir, region: 'global' }, deps);
  const second = await resolveSigningDirectory(f.dir);
  assert.notEqual(second, first); assert.equal(calls, 2);
  assert.equal(await readFile(join(second, 'source-bootstrap'), 'utf8'), 'synthetic');
  assert.equal(await readFile(join(second, 'source-wrapping-cert.pem'), 'utf8'), await readFile(join(f.dir, 'wrap.pem'), 'utf8'));
});

test('cancellation during issuance keeps the prior generation unchanged', async t => {
  const { provisionSigningCredentialsForTest } = await import('../dist/signing/bootstrap.js');
  const f = await issuanceFixture(t), controller = new AbortController();
  const deps = { ...f.pins, request: url => fakeIssuance(f, url) };
  await provisionSigningCredentialsForTest(f.options, false, deps);
  const previous = await readFile(join(f.dir, 'current'), 'utf8');
  await assert.rejects(provisionSigningCredentialsForTest({...f.options,signal:controller.signal}, false, { ...deps, request: async url => { const result=await fakeIssuance(f,url); controller.abort(); return result; } }));
  assert.equal(await readFile(join(f.dir, 'current'), 'utf8'), previous);
});
