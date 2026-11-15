// Synthetic independent certificates only; no operator/vendor material or network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { trackedMkdtempSync } from './support/temp.mjs';
import { validateAppMaterial, validateDeviceMaterial, certificateId, fingerprint, checkOpenSsl } from '../dist/signing/pki.js';
import { createSigningSession } from '../dist/signing/index.js';
import { SigningSession } from '../dist/signing/session.js';
import { SequenceStore } from '../dist/signing/sequence.js';
const run = promisify(execFile);
let f;
const utf8 = path => readFileSync(path, 'utf8');
function openssl(args, cwd) { return execFileSync('openssl', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function fixture() {
  const dir = realpathSync(trackedMkdtempSync(join(tmpdir(), 'bambu-signing-test-')));
  chmodSync(dir, 0o700);
  const put = (name, value) => { const path = join(dir, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  mkdirSync(join(dir, 'newcerts'));
  put('index.txt', ''); put('serial', '1001'); put('crlnumber', '1001');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Independent App CA', '-addext', 'basicConstraints=critical,CA:true,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash'], dir);
  put('ca.cnf', `[ca]\ndefault_ca=main\n[main]\ndir=${dir}\ndatabase=$dir/index.txt\nnew_certs_dir=$dir/newcerts\ncertificate=$dir/ca.pem\nprivate_key=$dir/ca.key\nserial=$dir/serial\ncrlnumber=$dir/crlnumber\ndefault_md=sha256\ndefault_days=10\ndefault_crl_days=5\npolicy=policy\n[policy]\ncommonName=supplied\n[app]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n[device]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,keyEncipherment,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n[badusage]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n[badcritical]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n1.2.3.4=critical,DER:01:01:FF\n`);
  function issue(name, cn, extension, dates = []) {
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + cn], dir);
    openssl(['ca', '-batch', '-notext', '-config', 'ca.cnf', '-extensions', extension, '-in', name + '.csr', '-out', name + '.pem', ...dates], dir);
  }
  issue('app', 'Signing Application', 'app');
  issue('device', 'SERIAL1234', 'device');
  issue('wrongserial', 'OTHER1234', 'device');
  issue('badusage', 'Bad Usage', 'badusage');
  issue('badcritical', 'Bad Critical', 'badcritical');
  issue('expired', 'Expired App', 'app', ['-startdate', '20000101000000Z', '-enddate', '20010101000000Z']);
  issue('future', 'Future App', 'app', ['-startdate', '20900101000000Z', '-enddate', '20910101000000Z']);
  openssl(['ca', '-gencrl', '-config', 'ca.cnf', '-out', 'valid.crl'], dir);
  openssl(['ca', '-config', 'ca.cnf', '-revoke', 'app.pem'], dir);
  openssl(['ca', '-gencrl', '-config', 'ca.cnf', '-out', 'revoked.crl'], dir);
  const ca = utf8(join(dir, 'ca.pem')), crl = utf8(join(dir, 'valid.crl')), pin = fingerprint(new X509Certificate(ca));
  return { dir, ca, crl, pin, put, issue, key: utf8(join(dir, 'app.key')), chain: utf8(join(dir, 'app.pem')) + ca, device: utf8(join(dir, 'device.pem')) + ca };
}
before(async () => { await checkOpenSsl(); f = fixture(); });
const app = (name = 'app', crl = f.crl, now = Date.now()) => validateAppMaterial(utf8(join(f.dir, name + '.key')), utf8(join(f.dir, name + '.pem')) + f.ca, crl, now, f.pin);

test('OpenSSL verifies synthetic direct pinned app path, key, usage and current CRL', async () => {
  const material = await app();
  assert.equal(material.certId, '1001CN=Independent App CA');
  assert.ok(material.expiresAt > Date.now());
  assert.equal(material.chainPem, f.chain);
  const device = await validateDeviceMaterial(f.device, f.ca, 'SERIAL1234', Date.now());
  assert.equal(device.publicKey.asymmetricKeyType, 'rsa');
});
test('production factory cannot replace the hardcoded CA with an uploaded CA', async () => {
  const directory = join(f.dir, 'operator'); mkdirSync(directory, { mode: 0o700 });
  for (const [name, data] of [['slicer_key.pem', f.key], ['slicer_cert.pem', f.chain], ['slicer_crl.pem', f.crl]]) writeFileSync(join(directory, name), data, { mode: 0o600 });
  await assert.rejects(createSigningSession({ serial: 'SERIAL1234', operatorPemDirectory: directory, deviceTrustPem: f.ca }), /SIGNING_APP_CA_PIN_MISMATCH/);
  chmodSync(join(directory, 'slicer_key.pem'), 0o644);
  await assert.rejects(createSigningSession({ serial: 'SERIAL1234', operatorPemDirectory: directory, deviceTrustPem: f.ca }), /SIGNING_OPERATOR_PEM_INVALID/);
});
test('app trust rejects wrong key, CA pin, usage, dates, critical extensions and revocation', async () => {
  await assert.rejects(validateAppMaterial(utf8(join(f.dir, 'device.key')), f.chain, f.crl, Date.now(), f.pin), /SIGNING_KEY_CERT_MISMATCH/);
  await assert.rejects(validateAppMaterial(f.key, f.chain, f.crl, Date.now(), '0'.repeat(64)), /SIGNING_APP_CA_PIN_MISMATCH/);
  await assert.rejects(app('badusage'), /SIGNING_KEY_USAGE_REQUIRED/);
  await assert.rejects(app('expired'), /SIGNING_CERT_EXPIRED_OR_NOT_YET_VALID/);
  await assert.rejects(app('future'), /SIGNING_CERT_EXPIRED_OR_NOT_YET_VALID/);
  await assert.rejects(app('badcritical'), /SIGNING_PKI_VERIFICATION_FAILED/);
  await assert.rejects(app('app', utf8(join(f.dir, 'revoked.crl'))), /SIGNING_PKI_VERIFICATION_FAILED/);
  await assert.rejects(app('app', '', Date.now()), /SIGNING_PEM_INVALID/);
  await assert.rejects(app('app', f.crl, Date.now() + 6 * 86400000), /SIGNING_CRL_STALE_OR_INVALID/);
  await assert.rejects(app('app', f.crl, Date.now() - 60000), /SIGNING_CERT_EXPIRED_OR_NOT_YET_VALID|SIGNING_CRL_STALE_OR_INVALID/);
});
test('device identity and independent trust fail closed', async () => {
  await assert.rejects(validateDeviceMaterial(utf8(join(f.dir, 'wrongserial.pem')) + f.ca, f.ca, 'SERIAL1234', Date.now()), /SIGNING_DEVICE_IDENTITY_MISMATCH/);
  await assert.rejects(validateDeviceMaterial(f.device, utf8(join(f.dir, 'app.pem')), 'SERIAL1234', Date.now()), /SIGNING_DEVICE_TRUST_INVALID/);
  await assert.rejects(validateDeviceMaterial(f.device, f.ca, 'SERIAL1234', Date.now() + 40 * 86400000), /SIGNING_CERT_EXPIRED_OR_NOT_YET_VALID/);
  // A chain supplied in a reply is untrusted; a separate CA must verify it.
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'other.key', '-out', 'other.pem', '-days', '10', '-subj', '/CN=Other Device CA', '-addext', 'basicConstraints=critical,CA:true', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], f.dir);
  await assert.rejects(validateDeviceMaterial(f.device, utf8(join(f.dir, 'other.pem')), 'SERIAL1234', Date.now()), /SIGNING_PKI_VERIFICATION_FAILED/);
  openssl(['ca', '-gencrl', '-config', 'ca.cnf', '-cert', 'other.pem', '-keyfile', 'other.key', '-out', 'other.crl'], f.dir);
  await assert.rejects(app('app', utf8(join(f.dir, 'other.crl'))), /SIGNING_PKI_VERIFICATION_FAILED/, 'a CRL for another issuer cannot cover the pinned leaf');
  const crlDer = Buffer.from(f.crl.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  crlDer[crlDer.length - 1] ^= 1;
  f.put('bad-signature.crl', '-----BEGIN X509 CRL-----\n' + crlDer.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END X509 CRL-----\n');
  await assert.rejects(app('app', utf8(join(f.dir, 'bad-signature.crl'))), /SIGNING_PKI_VERIFICATION_FAILED/, 'a current CRL with a bad signature cannot authorize the leaf');
});
test('RFC4514 issuer encoding agrees with independently generated UTF8, multivalued and escaped DN fixture', () => {
  // x509 self-signed issuer is the generated subject; this fixture exercises names only.
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-utf8', '-keyout', 'dn.key', '-out', 'dn.pem', '-days', '2', '-set_serial', '0xABC', '-subj', '/O=Example/OU=測試/CN=Issuer\\,\\+\\=\\#\\ /UID=identity+CN=Other'], f.dir);
  const certificate = new X509Certificate(utf8(join(f.dir, 'dn.pem')));
  const reference = openssl(['x509', '-in', 'dn.pem', '-noout', '-issuer', '-nameopt', 'RFC2253,utf8,-esc_msb'], f.dir).trim().replace(/^issuer=/, '');
  // RFC4514 deliberately has no canonical AVA order within an RDN. OpenSSL
  // prints the SET in reverse order; our encoder preserves its DER order.
  const result = certificateId(certificate);
  assert.equal(result, 'abcCN=Other+UID=identity,CN=Issuer\\,\\+=#\\ ,OU=測試,O=Example');
  assert.equal(result.replace('CN=Other+UID=identity', 'UID=identity+CN=Other'), 'abc' + reference);
  assert.match(reference, /測試/); assert.match(reference, /CN=Other\+UID=identity|UID=identity\+CN=Other/); assert.match(reference, /\\,/);
});

async function counterDirectory(label) {
  const directory = join(f.dir, label); mkdirSync(directory, { mode: 0o700 });
  await run(process.execPath, ['scripts/signing-setup.mjs', directory, '--last-used-sequence', '20000'], { cwd: new URL('../', import.meta.url).pathname });
  return directory;
}
test('durable counter reserves unique increasing values concurrently across independent processes and restarts', async () => {
  const directory = await counterDirectory('counter-concurrent');
  const helper = join(directory, 'counter-helper');
  const results = await Promise.all(Array.from({ length: 40 }, () => run(helper, ['next', directory])));
  const numbers = results.map(r => Number(r.stdout.trim())).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 40 }, (_, i) => 20001 + i));
  assert.equal(await new SequenceStore(directory).next(), '20041');
  assert.equal(await new SequenceStore(directory).next(), '20042', 'fresh instance reserves after persisted value');
  await assert.rejects(run(process.execPath, ['scripts/signing-setup.mjs', directory, '--last-used-sequence', '20000']), /SIGNING_SETUP_FAILED/);
  assert.equal(await new SequenceStore(directory).next(), '20043', 'setup never resets an existing counter');
  assert.equal(utf8(join(directory, 'counter')), '20043');
  await run(process.execPath, ['scripts/signing-setup.mjs', '--repair', directory]);
  assert.equal(utf8(join(directory, 'counter')), '20043', 'helper repair cannot rewind the durable state');
  assert.equal(await new SequenceStore(directory).next(), '20044');
});
test('missing, exhausted, unsafe and corrupt counter state blocks instead of silently resetting', async () => {
  const missing = join(f.dir, 'missing'); mkdirSync(missing, { mode: 0o700 });
  await assert.rejects(new SequenceStore(missing).next(), /SIGNING_SEQUENCE_UNAVAILABLE/);
  const directory = await counterDirectory('counter-invalid');
  writeFileSync(join(directory, 'counter'), 'garbage', { mode: 0o600 });
  await assert.rejects(new SequenceStore(directory).next(), /SIGNING_SEQUENCE_UNAVAILABLE/);
  writeFileSync(join(directory, 'counter'), '2147483647');
  await assert.rejects(new SequenceStore(directory).next(), /SIGNING_SEQUENCE_UNAVAILABLE/);
  chmodSync(directory, 0o755);
  await assert.rejects(new SequenceStore(directory).next(), /SIGNING_SEQUENCE_UNAVAILABLE/);
});
test('process death releases the OS lock and never reuses any successfully returned reservation', async () => {
  const directory = await counterDirectory('counter-crash'), helper = join(directory, 'counter-helper');
  const returned = [];
  for (let i = 0; i < 12; i++) {
    const child = spawn(helper, ['next', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; });
    const exit = new Promise(resolve => child.on('close', resolve));
    if (i % 2) child.kill('SIGKILL');
    await exit; if (/^\d+\s*$/.test(output)) returned.push(Number(output));
  }
  const after = Number(await new SequenceStore(directory).next());
  assert.equal(new Set(returned).size, returned.length);
  assert.ok(returned.every(value => value < after));
  assert.equal(Number(utf8(join(directory, 'counter'))), after);
});
test('session requires fully correlated device-certificate install, replaces sequences and invalidates reconnect replies', async () => {
  const directory = await counterDirectory('counter-session');
  let now = Date.now();
  const material = await app();
  const session = new SigningSession('SERIAL1234', material, f.ca, new SequenceStore(directory), () => now);
  await assert.rejects(session.signCommand({ command: 'stop' }), /SIGNING_NOT_READY/);
  const install = await session.beginInstall(1);
  const security = JSON.parse(install.payload).security;
  assert.equal(security.sequence_id, install.sequence); assert.equal(security.app_cert, f.chain); assert.equal(security.crl, f.crl);
  const reply = { security: { command: 'app_cert_install', sequence_id: install.sequence, result: 'SUCCESS', printer_cert: f.device } };
  assert.equal(await session.acceptInstallReply({ topic: 'device/OTHER/report', generation: 1, reply }), false);
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 2, reply }), false);
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 1, reply: { security: { ...reply.security, sequence_id: '999999' } } }), false);
  assert.equal(session.readiness().state, 'INSTALLING');
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 1, reply }), true);
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 1, reply }), false);
  const wire = await session.signCommand({ command: 'stop', sequence_id: '1', param: '' });
  const parsed = JSON.parse(wire), text = wire.toString('utf8'), payload = Buffer.from('{' + text.slice(text.indexOf(',"print"') + 1));
  assert.notEqual(parsed.print.sequence_id, install.sequence); assert.notEqual(parsed.print.sequence_id, '1');
  assert.equal(verify('sha256', payload, new X509Certificate(f.chain).publicKey, Buffer.from(parsed.header.sign_string, 'base64')), true);
  // Exercise the real installed session and wire encoder for the existing AMS HT
  // address. Model/capability authorization remains the typed caller's concern.
  for (const param of ['start_drying', 'stop_drying']) {
    const dryingBytes = await session.signCommand({ command: 'ams_control', ams_id: 128, param });
    const dryingText = dryingBytes.toString('utf8'), drying = JSON.parse(dryingText);
    const dryingPayload = Buffer.from('{' + dryingText.slice(dryingText.indexOf(',"print"') + 1));
    assert.equal(drying.print.ams_id, 128); assert.equal(drying.print.param, param);
    assert.equal(verify('sha256', dryingPayload, new X509Certificate(f.chain).publicKey, Buffer.from(drying.header.sign_string, 'base64')), true);
  }
  for (const ams_id of [4, 127, 129, -1]) await assert.rejects(session.signCommand({ command: 'ams_control', ams_id, param: 'start_drying' }), /SIGNING_COMMAND_INVALID/);
  session.disconnect(); assert.equal(session.readiness().state, 'DISCONNECTED');
  const newer = await session.beginInstall(2);
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 1, reply }), false);
  assert.notEqual(newer.sequence, install.sequence);
  now += 16000;
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 2, reply: { security: { ...reply.security, sequence_id: newer.sequence } } }), false);
  assert.equal(session.readiness().reason, 'SIGNING_INSTALL_TIMEOUT');
});
test('rejected/untrusted installs and expiry expose only repair codes; disconnect races revoke in-flight signing', async () => {
  const directory = await counterDirectory('counter-failure'), material = await app(); let now = Date.now();
  const session = new SigningSession('SERIAL1234', material, f.ca, new SequenceStore(directory), () => now);
  const install = await session.beginInstall('generation');
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 'generation', reply: { security: { command: 'app_cert_install', sequence_id: install.sequence, result: 'SUCCESS', printer_cert: 'PRIVATE SENSITIVE BAD INPUT' } } }), false);
  assert.equal(session.readiness().state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(session.readiness()), /PRIVATE|BEGIN|SERIAL/);
  const next = await session.beginInstall('next');
  const reply = { security: { command: 'app_cert_install', sequence_id: next.sequence, result: 'SUCCESS', printer_cert: f.device } };
  const accepting = session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 'next', reply });
  session.disconnect(); assert.equal(await accepting, false); assert.equal(session.readiness().state, 'DISCONNECTED');
  const fresh = await session.beginInstall('fresh');
  assert.equal(await session.acceptInstallReply({ topic: 'device/SERIAL1234/report', generation: 'fresh', reply: { security: { ...reply.security, sequence_id: fresh.sequence } } }), true);
  const signing = session.signCommand({ command: 'stop' }); session.disconnect();
  await assert.rejects(signing, /SIGNING_CONNECTION_CHANGED/);
  now = material.expiresAt;
  await assert.rejects(session.beginInstall('expired'), /SIGNING_MATERIAL_EXPIRED/);
  assert.equal(session.readiness().state, 'BLOCKED');
});

test('first setup chooses a random bounded starting point, then persists and refuses reinitialization', async () => {
  const directory = join(f.dir, 'counter-random');
  await run(process.execPath, ['scripts/signing-setup.mjs', directory]);
  const initial = Number(utf8(join(directory, 'counter')));
  assert.ok(initial >= 20000 && initial < 2 ** 30);
  assert.equal(await new SequenceStore(directory).next(), String(initial + 1));
  await assert.rejects(run(process.execPath, ['scripts/signing-setup.mjs', directory]), /SIGNING_SETUP_FAILED/);
  assert.equal(await new SequenceStore(directory).next(), String(initial + 2));
});
test('device path validation enforces CA path-length constraints and leaf key usage', async () => {
  f.put('intermediate.ext', 'basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n');
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-keyout', 'intermediate.key', '-out', 'intermediate.csr', '-subj', '/CN=Forbidden Subordinate CA'], f.dir);
  openssl(['x509', '-req', '-in', 'intermediate.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', '0x2001', '-days', '10', '-extfile', 'intermediate.ext', '-out', 'intermediate.pem'], f.dir);
  f.put('nested.ext', 'basicConstraints=critical,CA:false\nkeyUsage=critical,keyEncipherment,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n');
  openssl(['x509', '-req', '-in', 'device.csr', '-CA', 'intermediate.pem', '-CAkey', 'intermediate.key', '-set_serial', '0x2002', '-days', '10', '-extfile', 'nested.ext', '-out', 'nested.pem'], f.dir);
  const chain = utf8(join(f.dir, 'nested.pem')) + utf8(join(f.dir, 'intermediate.pem'));
  await assert.rejects(validateDeviceMaterial(chain, f.ca, 'SERIAL1234', Date.now()), /SIGNING_PKI_VERIFICATION_FAILED/);
  // App leaf is RSA but lacks device field-encryption usage; a matching CN alone
  // must not substitute for the separately checked key constraint.
  await assert.rejects(validateDeviceMaterial(utf8(join(f.dir, 'app.pem')), f.ca, 'Signing Application', Date.now()), /SIGNING_KEY_USAGE_REQUIRED/);
});
test('a process killed while owning the stable flock inode releases the next reservation', async () => {
  const directory = await counterDirectory('counter-held-lock');
  const source = join(directory, 'holder.c'), binary = join(directory, 'holder');
  writeFileSync(source, '#include <sys/file.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <unistd.h>\nint main(int argc,char**argv){if(argc!=2)return 1;int fd=open(argv[1],O_RDWR);if(fd<0||flock(fd,LOCK_EX))return 2;puts("locked");fflush(stdout);for(;;)pause();}\n', { mode: 0o600 });
  await run('cc', [source, '-o', binary]);
  const holder = spawn(binary, [join(directory, 'counter.lock')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('lock holder exited before lock proof'))); });
    let completed = false;
    const waiting = new SequenceStore(directory).next().then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, 'reservation blocks behind an actual held OS lock');
    holder.kill('SIGKILL');
    assert.equal(await waiting, '20001');
    assert.equal(await new SequenceStore(directory).next(), '20002');
  } finally { holder.kill('SIGKILL'); }
});
