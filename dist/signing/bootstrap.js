/** Explicit vendor application credential issuance. No account or printer call.
 * Protocol evidence: Android IotCertManager/IotApi and independent successful
 * interoperability experiment (AES-GCM framing and RSA PKCS#1 v1.5). The
 * bootstrap is supplied privately by the operator, never distributed here.
 */
import { constants, X509Certificate, createCipheriv, createDecipheriv, createPrivateKey, publicEncrypt, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, lstat, realpath, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { get } from 'node:https';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { APP_CA_SHA256, checkOpenSsl, fail, fingerprint, SigningError, validateAppMaterial } from './pki.js';
const WRAPPING_CERT_SHA256 = '2a5e9b8fd6a3b3642b5d9f4d1fd1cd354d0d5cb2caa76e66ed76f2bb97a6d5bb';
const MAX_RESPONSE = 2 * 1024 * 1024;
const GENERATION = /^generation-[a-f0-9]{32}$/;
async function privateDirectory(directory) {
    if (!isAbsolute(directory) || await realpath(directory) !== directory)
        return fail('SIGNING_MANAGED_DIRECTORY_INVALID');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        fail('SIGNING_MANAGED_DIRECTORY_INVALID');
}
async function readPrivate(path, max = 128 * 1024) {
    if (!isAbsolute(path))
        return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
    const fd = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size <= 0 || stat.size > max)
            return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
        const data = await fd.readFile('utf8');
        if (Buffer.byteLength(data) > max)
            return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
        return data;
    }
    finally {
        await fd.close();
    }
}
async function syncPath(path) { const fd = await open(path, fsConstants.O_RDONLY); try {
    await fd.sync();
}
finally {
    await fd.close();
} }
async function put(path, value) {
    const fd = await open(path, 'wx', 0o600);
    try {
        await fd.writeFile(value, 'utf8');
        await fd.sync();
    }
    finally {
        await fd.close();
    }
}
/** Resolve one immutable generation at session creation. Legacy direct PEMs remain supported. */
export async function resolveSigningDirectory(directory) {
    let pointer;
    try {
        pointer = await readPrivate(join(directory, 'current'), 128);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return directory;
        throw error;
    }
    await privateDirectory(directory);
    const name = pointer.trim();
    if (!GENERATION.test(name) || pointer !== `${name}\n`)
        return fail('SIGNING_MANAGED_DIRECTORY_INVALID');
    const generation = join(directory, name);
    await privateDirectory(generation);
    return generation;
}
// A helper holds an OS flock on a stable inode until its stdin closes. The OS
// releases it after either process dies; no lock-file deletion or PID lease.
export async function acquireSigningLockForTest(directory) {
    const script = `import fcntl,os,stat,sys
p=sys.argv[1]
f=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
s=os.fstat(f)
if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077 or s.st_nlink != 1: sys.exit(1)
fcntl.flock(f,fcntl.LOCK_EX)
sys.stdout.write("READY\\n");sys.stdout.flush()
sys.stdin.buffer.read()
`;
    const child = spawn('python3', ['-c', script, join(directory, '.issuance.lock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => { });
    child.stderr.resume();
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(false), 5000);
        const finish = (success) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            if (success)
                resolve(child);
            else {
                child.kill('SIGKILL');
                reject(new SigningError('SIGNING_ISSUANCE_LOCK_UNAVAILABLE'));
            }
        };
        child.stdout.once('data', data => finish(data.toString() === 'READY\n'));
        child.once('error', () => finish(false));
        child.once('exit', () => finish(false));
    });
}
async function currentPointer(directory) {
    try {
        return await readPrivate(join(directory, 'current'), 128);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/** Internal transport seam for deterministic timeout testing; callers cannot select
 * an endpoint through an MCP tool. Production always uses the fixed hosts below. */
export function requestCredentialForTest(url, transport = get, deadlineMs = 20000, signal) {
    if (signal?.aborted)
        return Promise.reject(new SigningError('SIGNING_ISSUANCE_FAILED'));
    return new Promise((resolve, reject) => {
        let settled = false;
        let responseStream;
        const finish = (error, data) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(deadline);
            if (error)
                reject(error);
            else
                resolve(data);
        };
        const deadline = setTimeout(() => {
            finish(new SigningError('SIGNING_ISSUANCE_FAILED'));
            responseStream?.destroy();
            req.destroy();
        }, deadlineMs);
        const req = transport(url, { headers: { Accept: 'application/json' }, agent: false, timeout: deadlineMs, signal }, response => {
            responseStream = response;
            if (response.statusCode !== 200) {
                response.resume();
                finish(new SigningError('SIGNING_ISSUANCE_REJECTED'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => { size += chunk.length; if (size > MAX_RESPONSE) {
                finish(new SigningError('SIGNING_ISSUANCE_RESPONSE_INVALID'));
                response.destroy();
            }
            else
                chunks.push(chunk); });
            response.on('end', () => finish(undefined, Buffer.concat(chunks)));
            response.on('error', () => finish(new SigningError('SIGNING_ISSUANCE_FAILED')));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => finish(new SigningError('SIGNING_ISSUANCE_FAILED')));
    });
}
/** Internal wire primitives; production validates the wrapping pin before use. */
export function encodeCredentialRequest(bootstrap, publicKey, aes, iv) {
    const cipher = createCipheriv('aes-256-gcm', aes, iv);
    const encrypted = Buffer.concat([iv, cipher.update(`GLOF3813734089-${bootstrap}`, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { encrypted, wrapped: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, aes) };
}
export function decryptCredentialKey(encoded, aes) {
    const envelope = Buffer.from(encoded, 'base64');
    if (envelope.length <= 28)
        return fail('SIGNING_ISSUANCE_RESPONSE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', aes, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(-16));
    return Buffer.concat([decipher.update(envelope.subarray(12, -16)), decipher.final()]);
}
const retryInterval = 24 * 60 * 60 * 1000;
/** Each call deliberately issues a new generation; no implicit retries or network on startup. */
export async function provisionSigningCredentials(options, automatic = false) {
    return provisionSigningCredentialsForTest(options, automatic, { request: url => requestCredentialForTest(url, undefined, 20000, options.signal), appPin: APP_CA_SHA256, wrapPin: WRAPPING_CERT_SHA256, clock: Date.now });
}
/** Internal test seam only; MCP and production callers cannot supply these dependencies. */
export async function provisionSigningCredentialsForTest(options, automatic, dependencies) {
    let lock, staging;
    let aes, plaintext;
    try {
        options.signal?.throwIfAborted();
        await privateDirectory(options.directory);
        if (options.region !== 'global' && options.region !== 'cn')
            return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
        lock = await acquireSigningLockForTest(options.directory);
        options.signal?.throwIfAborted();
        const previousPointer = await currentPointer(options.directory);
        if (options.expectedGeneration && previousPointer !== `${options.expectedGeneration}\n`)
            return fail('SIGNING_GENERATION_CHANGED');
        if (automatic) {
            let last = 0;
            try {
                const value = await readPrivate(join(options.directory, '.last-automatic-attempt'), 32);
                if (!/^\d{13}\n$/.test(value))
                    return fail('SIGNING_RENEWAL_STATE_INVALID');
                last = Number(value.trim());
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            const timestamp = dependencies.clock();
            if (last > timestamp || timestamp - last < retryInterval)
                return fail('SIGNING_RENEWAL_THROTTLED');
            const attempt = join(options.directory, `.attempt-${randomBytes(16).toString('hex')}`);
            try {
                await put(attempt, `${timestamp}\n`);
                await rename(attempt, join(options.directory, '.last-automatic-attempt'));
                await syncPath(options.directory);
            }
            finally {
                await rm(attempt, { force: true });
            }
        }
        const bootstrap = (await readPrivate(options.bootstrapFile, 1024)).trim();
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(bootstrap))
            return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
        const wrappingPem = await readPrivate(options.wrappingCertificateFile);
        const wrap = new X509Certificate(wrappingPem);
        const now = dependencies.clock();
        if (fingerprint(wrap) !== dependencies.wrapPin || now < Date.parse(wrap.validFrom) || now >= Date.parse(wrap.validTo) || wrap.publicKey.asymmetricKeyType !== 'rsa' || wrap.publicKey.asymmetricKeyDetails?.modulusLength !== 2048)
            return fail('SIGNING_BOOTSTRAP_WRAP_CERT_INVALID');
        await checkOpenSsl();
        aes = randomBytes(32);
        const iv = randomBytes(12);
        const { encrypted, wrapped } = encodeCredentialRequest(bootstrap, wrap.publicKey, aes, iv);
        const base64url = (data) => data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
        const host = options.region === 'cn' ? 'api.lunkuocorp.cn' : 'api.bambulab.com';
        const url = new URL(`https://${host}/v1/iot-service/api/user/applications/${base64url(encrypted)}/cert`);
        url.searchParams.set('aes256', base64url(wrapped));
        options.signal?.throwIfAborted();
        const response = JSON.parse((await dependencies.request(url)).toString('utf8'));
        if (response.code !== 0 || typeof response.cert !== 'string' || typeof response.key !== 'string')
            return fail('SIGNING_ISSUANCE_RESPONSE_INVALID');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.key))
            return fail('SIGNING_ISSUANCE_RESPONSE_INVALID');
        plaintext = decryptCredentialKey(response.key, aes);
        let privateKey;
        try {
            privateKey = createPrivateKey(plaintext);
        }
        catch {
            privateKey = createPrivateKey({ key: plaintext, format: 'der', type: 'pkcs8' });
        }
        plaintext.fill(0);
        aes.fill(0);
        const key = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
        const crl = typeof response.crl === 'string' ? response.crl : Array.isArray(response.crl) && response.crl.every(v => typeof v === 'string') ? response.crl.join('\n') : '';
        const material = await validateAppMaterial(key, response.cert, crl, now, dependencies.appPin);
        options.signal?.throwIfAborted();
        const name = `generation-${randomBytes(16).toString('hex')}`;
        staging = join(options.directory, name);
        await mkdir(staging, { mode: 0o700 });
        await put(join(staging, 'slicer_key.pem'), key);
        await put(join(staging, 'slicer_cert.pem'), material.chainPem);
        await put(join(staging, 'slicer_crl.pem'), material.crlPem);
        if (options.persistSource) {
            await put(join(staging, 'source-bootstrap'), bootstrap);
            await put(join(staging, 'source-wrapping-cert.pem'), wrappingPem);
        }
        await syncPath(staging);
        await syncPath(options.directory);
        const pointer = join(options.directory, `.current-${randomBytes(16).toString('hex')}`);
        try {
            await put(pointer, `${name}\n`);
            options.signal?.throwIfAborted();
            if (lock.exitCode !== null || lock.signalCode !== null)
                return fail('SIGNING_ISSUANCE_LOCK_UNAVAILABLE');
            if (await currentPointer(options.directory) !== previousPointer)
                return fail('SIGNING_GENERATION_CHANGED');
            options.signal?.throwIfAborted();
            await rename(pointer, join(options.directory, 'current'));
            staging = undefined;
            await syncPath(options.directory);
        }
        finally {
            await rm(pointer, { force: true });
        }
        staging = undefined;
        return { expiresAt: new Date(material.expiresAt).toISOString() };
    }
    catch (error) {
        if (error instanceof SigningError)
            throw error;
        throw new SigningError('SIGNING_ISSUANCE_FAILED');
    }
    finally {
        if (staging)
            await rm(staging, { recursive: true, force: true });
        aes?.fill(0);
        plaintext?.fill(0);
        lock?.stdin.end();
    }
}
/** Extract from a verified operator APK, then atomically bind its private source
 * to the published credential generation. No random source directory remains. */
export async function provisionSigningCredentialsFromApk(options) {
    const { extractHandyBootstrap } = await import('./android-source.js');
    const inputs = await extractHandyBootstrap(options.apkFile, options.directory);
    try {
        options.signal?.throwIfAborted();
        return await provisionSigningCredentials({ directory: options.directory, ...inputs, region: options.region, persistSource: true, signal: options.signal });
    }
    finally {
        await rm(dirname(inputs.bootstrapFile), { recursive: true, force: true });
    }
}
/** Explicit one-click setup from the fixed, reviewed official package. */
export async function provisionSigningCredentialsFromOfficialPackage(options) {
    try {
        const { downloadReviewedPackageForTest } = await import('./official-package.js');
        return await provisionOfficialPackageForTest(options, {
            download: (path, signal) => downloadReviewedPackageForTest(path, { signal }),
            provision: provisionSigningCredentialsFromApk,
        });
    }
    catch (error) {
        if (error instanceof SigningError)
            throw error;
        throw new SigningError('SIGNING_ISSUANCE_FAILED');
    }
}
/** Internal seam to exercise acquisition, cleanup and issuance ordering offline. */
export async function provisionOfficialPackageForTest(options, dependencies) {
    options.signal?.throwIfAborted();
    await privateDirectory(options.directory);
    const temp = await mkdtemp(join(options.directory, '.official-package-'));
    try {
        const apkFile = join(temp, 'handy.apk');
        await dependencies.download(apkFile, options.signal);
        options.signal?.throwIfAborted();
        return await dependencies.provision({ directory: options.directory, apkFile, region: options.region, signal: options.signal });
    }
    finally {
        await rm(temp, { recursive: true, force: true });
    }
}
/** On-demand automatic renewal, only when explicitly configured. A still valid
 * current bundle remains usable if renewal fails; invalid or revoked never does.
 * Attempts are durably throttled across processes and never retried by a call. */
export async function ensureManagedSigningCredentials(options) {
    return ensureManagedSigningCredentialsForTest(options, { request: requestCredentialForTest, appPin: APP_CA_SHA256, wrapPin: WRAPPING_CERT_SHA256, clock: Date.now });
}
/** Internal synthetic authority seam; production always fixes pins and transport. */
export async function ensureManagedSigningCredentialsForTest(options, dependencies) {
    let validUntil = 0;
    try {
        const dir = await resolveSigningDirectory(options.directory);
        if (dir === options.directory)
            throw new Error('No managed generation');
        const [key, chain, crl] = await Promise.all(['slicer_key.pem', 'slicer_cert.pem', 'slicer_crl.pem'].map(name => readPrivate(join(dir, name))));
        const current = await validateAppMaterial(key, chain, crl, dependencies.clock(), dependencies.appPin);
        validUntil = current.expiresAt;
        if (validUntil - dependencies.clock() > 7 * 86400000)
            return;
    }
    catch { /* Renew invalid or missing material; never use it as fallback. */ }
    try {
        if (Boolean(options.bootstrapFile) !== Boolean(options.wrappingCertificateFile))
            return fail('SIGNING_BOOTSTRAP_INPUT_INVALID');
        const current = await resolveSigningDirectory(options.directory);
        if (!options.bootstrapFile && current === options.directory)
            return fail('SIGNING_MANAGED_SOURCE_UNAVAILABLE');
        await provisionSigningCredentialsForTest({ directory: options.directory, region: options.region, bootstrapFile: options.bootstrapFile ?? join(current, 'source-bootstrap'), wrappingCertificateFile: options.wrappingCertificateFile ?? join(current, 'source-wrapping-cert.pem'), persistSource: !options.bootstrapFile, expectedGeneration: options.bootstrapFile ? undefined : basename(current) }, true, dependencies);
    }
    catch (error) {
        if (validUntil > dependencies.clock()) {
            // Re-read: expiry or local revocation material may have changed while issuing.
            const dir = await resolveSigningDirectory(options.directory);
            const [key, chain, crl] = await Promise.all(['slicer_key.pem', 'slicer_cert.pem', 'slicer_crl.pem'].map(name => readPrivate(join(dir, name))));
            await validateAppMaterial(key, chain, crl, dependencies.clock(), dependencies.appPin);
            if (!(error instanceof SigningError && error.code === 'SIGNING_RENEWAL_THROTTLED'))
                process.stderr.write('Signing credential renewal failed; current validated generation remains in use.\n');
            return;
        }
        throw error;
    }
}
