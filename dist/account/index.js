import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { readFilamentLibrary } from '../filament-library.js';
import { prepareFilamentAction, projectAccountResponse, classifyFilamentResult } from './filament-actions.js';
import { historyPageRequest, projectHistoryPage } from './history.js';
import { readHistoryCover } from './history-media.js';
import { withAccountLock } from './session-store.js';
class AccountAuthenticationError extends Error {
    constructor() { super('Bambu rejected account authentication.'); }
}
const regions = {
    global: { api: 'https://api.bambulab.com', mqtt: 'mqtts://us.mqtt.bambulab.com:8883' },
    china: { api: 'https://api.bambulab.cn', mqtt: 'mqtts://cn.mqtt.bambulab.com:8883' },
};
class HttpVendor {
    async resendPhone(phone) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 15000);
        try {
            const result = await fetch('https://bambulab.cn/api/v1/user-service/user/sendsmscode', {
                method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ phone, type: 'codeLogin' }),
            });
            if (!result.ok)
                throw new Error('Bambu rejected the code request.');
        }
        catch (e) {
            if (e instanceof Error && e.message === 'Bambu rejected the code request.')
                throw e;
            throw new Error('Bambu request failed or timed out.');
        }
        finally {
            clearTimeout(timer);
        }
    }
    async verifyTotp(region, key, code) {
        const website = region === 'china' ? 'https://bambulab.cn' : 'https://bambulab.com';
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 15000);
        try {
            const csrf = await fetch(website + '/api/csrf', { signal: abort.signal, redirect: 'error' });
            if (csrf.status !== 204)
                throw new Error('Bambu verification is blocked or unavailable.');
            const cookies = csrf.headers.get('set-cookie') ?? '';
            const match = /(?:^|[,;]\s*)bbl_csrf_token=([^;,\s]+)/.exec(cookies);
            if (!match)
                throw new Error('Bambu verification is blocked or unavailable.');
            const result = await fetch(website + '/api/sign-in/tfa', { method: 'POST', redirect: 'error', signal: abort.signal,
                headers: { 'content-type': 'application/json', 'x-bbl-csrf-token': match[1], cookie: `bbl_csrf_token=${match[1]}` },
                body: JSON.stringify({ tfaKey: key, tfaCode: code }) });
            if (result.status === 400)
                throw new Error('Incorrect authenticator code.');
            if (result.status === 403 || result.status === 429)
                throw new Error('Bambu verification is blocked or rate limited.');
            if (!result.ok)
                throw new Error('Bambu verification failed.');
            const token = /(?:^|[,;]\s*)token=([^;,\s]+)/.exec(result.headers.get('set-cookie') ?? '')?.[1];
            if (!token)
                throw new Error('Bambu did not provide an account token.');
            return { accessToken: token };
        }
        catch (e) {
            if (e instanceof Error && ['Incorrect authenticator code.', 'Bambu verification is blocked or unavailable.', 'Bambu verification is blocked or rate limited.', 'Bambu verification failed.', 'Bambu did not provide an account token.'].includes(e.message))
                throw e;
            throw new Error('Bambu request failed or timed out.');
        }
        finally {
            clearTimeout(timer);
        }
    }
    async request(region, path, body, token, signal) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 15000);
        const cancel = () => abort.abort();
        if (signal?.aborted)
            abort.abort();
        else
            signal?.addEventListener('abort', cancel, { once: true });
        try {
            const response = await fetch(regions[region].api + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: abort.signal,
                headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!response.ok) {
                if (response.status === 401 && token && !body)
                    throw new AccountAuthenticationError();
                if (response.status === 400 && body && 'code' in body) {
                    const length = Number(response.headers.get('content-length') ?? 0);
                    if (length <= 16384) {
                        const errorBody = await responseText(response, 16384);
                        if (errorBody.length <= 16384) {
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.code === 1)
                                    throw new Error('Verification code expired.');
                                if (parsed.code === 2)
                                    throw new Error('Incorrect verification code.');
                            }
                            catch (e) {
                                if (e instanceof Error && ['Verification code expired.', 'Incorrect verification code.'].includes(e.message))
                                    throw e;
                            }
                        }
                    }
                }
                throw new Error(response.status === 429 ? 'Bambu rate limit reached; try again later.' : 'Bambu rejected the request.');
            }
            const length = Number(response.headers.get('content-length') ?? 0);
            if (length > 1024 * 1024)
                throw new Error('Bambu response too large.');
            const raw = await responseText(response, 1024 * 1024);
            if (raw.length > 1024 * 1024)
                throw new Error('Bambu response too large.');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('Invalid Bambu response.');
            return parsed;
        }
        catch (e) {
            if (e instanceof AccountAuthenticationError)
                throw e;
            if (e instanceof Error && ['Bambu rate limit reached; try again later.', 'Bambu rejected the request.', 'Bambu response too large.', 'Invalid Bambu response.', 'Verification code expired.', 'Incorrect verification code.'].includes(e.message))
                throw e;
            throw new Error('Bambu request failed or timed out.');
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
        }
    }
}
const isRegion = (value) => value === 'global' || value === 'china';
const shortString = (x) => typeof x === 'string' && x.length > 0 && x.length <= 2048;
export class AccountManager {
    beginAction() {
        if (this.logoutInProgress)
            throw new Error('Account logout in progress.');
        return { generation: this.authorityGeneration, signal: this.authorityAbort.signal };
    }
    assertAction(action) {
        if (this.logoutInProgress || action.generation !== this.authorityGeneration || action.signal.aborted)
            throw new Error('Account authority changed; retry the action explicitly.');
    }
    invalidateAuthority(action) {
        if (action)
            this.assertAction(action);
        this.authorityGeneration++;
        this.historyCached = undefined;
        this.historyPages.clear();
        this.historyLastAttempt = 0;
        this.historyAuthority = '';
        this.authorityAbort.abort(new Error('Account authority changed during inventory read.'));
        this.authorityAbort = new AbortController();
        if (action) {
            action.generation = this.authorityGeneration;
            action.signal = this.authorityAbort.signal;
        }
    }
    constructor(options = {}) {
        this.flowGeneration = 0;
        this.authorityGeneration = 0;
        this.authorityAbort = new AbortController();
        this.logoutInProgress = 0;
        this.writes = Promise.resolve();
        this.accountActions = Promise.resolve();
        this.historyLastAttempt = 0;
        this.historyAuthority = '';
        this.historyPages = new Map();
        this.directory = resolve(options.sessionDirectory ?? join(homedir(), '.config', 'bambu-printer-mcp', 'account'));
        this.vendor = options.vendor ?? new HttpVendor();
        this.lockObserver = options.lockObserverForTest;
    }
    get file() { return join(this.directory, 'session.json'); }
    async load() {
        try {
            const dir = await fs.lstat(this.directory);
            if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid()))
                throw new Error('Account directory must be private and owned by the current user.');
            const stat = await fs.lstat(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 32768)
                throw new Error('Account session file must be private and owned by the current user.');
            const obj = JSON.parse(await fs.readFile(this.file, 'utf8'));
            if (!obj || typeof obj !== 'object')
                throw new Error('Invalid account session.');
            const s = obj;
            if (s.version !== 1 || !isRegion(s.region) || !shortString(s.token) || !(s.expiresAt === null || Number.isSafeInteger(s.expiresAt)) || (s.refreshToken !== undefined && !shortString(s.refreshToken)) || (s.refreshExpiresAt !== undefined && s.refreshExpiresAt !== null && !Number.isSafeInteger(s.refreshExpiresAt)) || (s.refreshPending !== undefined && typeof s.refreshPending !== 'boolean') || (s.identity !== undefined && !/^u_\d{1,20}$/.test(s.identity)))
                throw new Error('Invalid account session.');
            return s;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            throw new Error('Cannot read private account session; check its ownership and permissions.');
        }
    }
    async status() {
        const action = this.beginAction();
        const s = await this.load();
        this.assertAction(action);
        return { state: !s ? 'not_configured' : s.refreshPending || s.expiresAt !== null && s.expiresAt <= Date.now() ? 'expired' : 'ready', ...(s ? { region: s.region, ...(s.expiresAt === null ? {} : { expiresAt: new Date(s.expiresAt).toISOString() }) } : {}), loginInProgress: !!this.active || !!this.starting, refreshState: s?.refreshPending || (s?.refreshExpiresAt != null && s.refreshExpiresAt <= Date.now()) ? 'reauth_required' : s?.refreshToken && s.identity ? 'available' : 'unavailable' };
    }
    enqueueWrite(work) {
        const result = this.writes.then(work);
        this.writes = result.then(() => undefined, () => undefined);
        return result;
    }
    async authorityEpoch() {
        const path = join(this.directory, '.authority');
        try {
            const st = await fs.lstat(path);
            if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || st.size > 64)
                throw new Error();
            const epoch = await fs.readFile(path, 'utf8');
            if (!/^[a-f0-9]{32}$/.test(epoch))
                throw new Error();
            return epoch;
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return 'initial';
            throw new Error('Account authority marker unavailable.');
        }
    }
    async advanceEpoch() {
        const temporary = join(this.directory, `.authority-${randomBytes(16).toString('hex')}`);
        try {
            const file = await fs.open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(randomBytes(16).toString('hex'));
                await file.sync();
            }
            finally {
                await file.close();
            }
            await fs.rename(temporary, join(this.directory, '.authority'));
            const dir = await fs.open(this.directory, 'r');
            try {
                await dir.sync();
            }
            finally {
                await dir.close();
            }
        }
        finally {
            await fs.unlink(temporary).catch(() => { });
        }
    }
    async save(session, isActive, expectedEpoch) {
        // Invalidate queued credentials before beginning account rotation.
        this.invalidateAuthority();
        return this.enqueueWrite(async () => withAccountLock(this.directory, async () => {
            if (!isActive())
                throw new Error('Login flow expired.');
            if (await this.authorityEpoch() !== expectedEpoch)
                throw new Error('Login flow expired.');
            await this.advanceEpoch();
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const st = await fs.lstat(this.directory);
            if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid()))
                throw new Error('Account directory must be private and owned by the current user.');
            const previous = await this.load();
            const writeAtomic = async (value) => {
                const temporary = join(this.directory, `.session-${randomBytes(16).toString('hex')}`);
                try {
                    const h = await fs.open(temporary, 'wx', 0o600);
                    try {
                        await h.writeFile(JSON.stringify(value));
                        await h.sync();
                    }
                    finally {
                        await h.close();
                    }
                    if (!isActive() && value === session)
                        throw new Error('Login flow expired.');
                    await fs.rename(temporary, this.file);
                    const dir = await fs.open(this.directory, 'r');
                    try {
                        await dir.sync();
                    }
                    finally {
                        await dir.close();
                    }
                }
                finally {
                    await fs.unlink(temporary).catch(() => { });
                }
            };
            await writeAtomic(session);
            if (!isActive()) {
                // A cancel during rename must not leave the cancelled token installed.
                if (previous)
                    await writeAtomic(previous);
                else {
                    await fs.unlink(this.file).catch(e => { if (e.code !== 'ENOENT')
                        throw e; });
                    const dir = await fs.open(this.directory, 'r');
                    try {
                        await dir.sync();
                    }
                    finally {
                        await dir.close();
                    }
                }
                throw new Error('Login flow expired.');
            }
            this.invalidateAuthority();
        }));
    }
    async session(signal, action) {
        if (action)
            this.assertAction(action);
        signal?.throwIfAborted();
        const epoch = await this.authorityEpoch();
        const initial = await this.load();
        if (epoch !== await this.authorityEpoch())
            throw new Error('Account authority changed; retry the read explicitly.');
        if (action)
            this.assertAction(action);
        signal?.throwIfAborted();
        if (!initial)
            throw new Error('Account session missing or expired; sign in again.');
        initial.authorityEpoch = epoch;
        if (initial.refreshPending)
            return this.refreshSession(initial, false, signal, action);
        if (initial.refreshToken && initial.expiresAt !== null && initial.expiresAt <= Date.now() + 60000)
            return this.refreshSession(initial, false, signal, action);
        if (initial.expiresAt !== null && initial.expiresAt <= Date.now())
            throw new Error('Account session missing or expired; sign in again.');
        return initial;
    }
    async identity(region, token, signal) {
        const pref = await this.vendor.request(region, '/v1/design-user-service/my/preference', undefined, token, signal);
        if (typeof pref.uid === 'number' && !Number.isSafeInteger(pref.uid))
            throw new Error('Invalid account identity.');
        const uid = String(pref.uid ?? '');
        if (!/^\d{1,20}$/.test(uid))
            throw new Error('Invalid account identity.');
        return `u_${uid}`;
    }
    async atomicSession(value) {
        const temp = join(this.directory, `.session-${randomBytes(16).toString('hex')}`);
        try {
            const handle = await fs.open(temp, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(value));
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await fs.rename(temp, this.file);
            const dir = await fs.open(this.directory, 'r');
            try {
                await dir.sync();
            }
            finally {
                await dir.close();
            }
        }
        finally {
            await fs.unlink(temp).catch(() => { });
        }
    }
    async refreshSession(expected, force = false, signal, action) {
        if (action)
            this.assertAction(action);
        signal?.throwIfAborted();
        const originalGeneration = this.authorityGeneration;
        return this.enqueueWrite(async () => withAccountLock(this.directory, async () => {
            signal?.throwIfAborted();
            if (action)
                this.assertAction(action);
            if (originalGeneration !== this.authorityGeneration)
                throw new Error('Account authority changed; retry the read explicitly.');
            if (!expected.authorityEpoch || await this.authorityEpoch() !== expected.authorityEpoch)
                throw new Error('Account authority changed; retry the read explicitly.');
            const previous = await this.load();
            if (!previous || previous.refreshPending)
                throw new Error('Account refresh outcome uncertain; sign in again.');
            if (previous.region !== expected.region || !expected.identity || previous.identity !== expected.identity)
                throw new Error('Account authority changed; retry the read explicitly.');
            if (previous.token !== expected.token) {
                if (await this.identity(previous.region, previous.token, signal) !== expected.identity)
                    throw new Error('Account authority changed; retry the read explicitly.');
                signal?.throwIfAborted();
                if (originalGeneration !== this.authorityGeneration)
                    throw new Error('Account authority changed; retry the read explicitly.');
                return { ...previous, authorityEpoch: expected.authorityEpoch };
            }
            if (!force && (previous.expiresAt === null || previous.expiresAt > Date.now() + 60000))
                return { ...previous, authorityEpoch: expected.authorityEpoch };
            if (!previous.refreshToken || !previous.identity || (previous.refreshExpiresAt != null && previous.refreshExpiresAt <= Date.now()))
                throw new Error('Account session expired; sign in again.');
            // Persist before the one-time exchange: a crash or ambiguous response never spends the old token again.
            signal?.throwIfAborted();
            await this.atomicSession({ ...previous, refreshPending: true });
            if (originalGeneration !== this.authorityGeneration)
                throw new Error('Account authority changed; retry the read explicitly.');
            this.invalidateAuthority(action);
            const generation = this.authorityGeneration;
            try {
                signal?.throwIfAborted();
                if (generation !== this.authorityGeneration)
                    throw new Error('Account authority changed.');
                const response = await this.vendor.request(previous.region, '/v1/user-service/user/refreshtoken', { refreshToken: previous.refreshToken }, undefined, signal);
                if (!shortString(response.accessToken))
                    throw new Error('Invalid refresh response.');
                const seconds = Number(response.expiresIn);
                if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400)
                    throw new Error('Invalid refresh response.');
                // Handy auth/network/a.java:64-83 retains its stored token when the
                // successful response omits it; qwb.java keeps access/refresh separate.
                const refreshToken = response.refreshToken == null ? previous.refreshToken : response.refreshToken;
                if (!shortString(refreshToken))
                    throw new Error('Invalid refresh response.');
                const refreshSeconds = response.refreshExpiresIn;
                if (refreshSeconds !== undefined && refreshSeconds !== null && (!Number.isFinite(Number(refreshSeconds)) || Number(refreshSeconds) <= 0 || Number(refreshSeconds) > 366 * 86400))
                    throw new Error('Invalid refresh response.');
                if (await this.identity(previous.region, response.accessToken, signal) !== previous.identity)
                    throw new Error('Account identity changed.');
                signal?.throwIfAborted();
                if (generation !== this.authorityGeneration)
                    throw new Error('Account authority changed.');
                const next = { version: 1, region: previous.region, token: response.accessToken, expiresAt: Math.floor(Date.now() + seconds * 1000), identity: previous.identity, refreshToken, refreshExpiresAt: refreshSeconds == null ? previous.refreshExpiresAt ?? null : Math.floor(Date.now() + Number(refreshSeconds) * 1000) };
                await this.atomicSession(next);
                this.invalidateAuthority(action);
                return { ...next, authorityEpoch: expected.authorityEpoch };
            }
            catch {
                throw new Error('Account refresh outcome uncertain; sign in again.');
            }
        }, signal, this.lockObserver));
    }
    async listFilamentInventory(env = process.env, signal) {
        const action = this.beginAction();
        const explicit = Boolean(env.BAMBU_SIGNED_CLOUD_BROKER || env.BAMBU_SIGNED_CLOUD_USERNAME || env.BAMBU_SIGNED_CLOUD_TOKEN);
        const session = explicit ? undefined : await this.session(signal, action);
        try {
            return await this.listFilamentInventoryAttempt(env, signal, session, action);
        }
        catch (e) {
            if (!(e instanceof AccountAuthenticationError) || !session)
                throw e;
            const renewed = await this.refreshSession(session, true, signal, action);
            return this.listFilamentInventoryAttempt(env, signal, renewed, action);
        }
    }
    async listFilamentInventoryAttempt(env, signal, expected, action) {
        this.assertAction(action);
        signal?.throwIfAborted();
        const credentials = [env.BAMBU_SIGNED_CLOUD_BROKER?.trim(), env.BAMBU_SIGNED_CLOUD_USERNAME?.trim(), env.BAMBU_SIGNED_CLOUD_TOKEN];
        const count = credentials.filter(Boolean).length;
        if (count !== 0 && count !== 3)
            throw new Error('Signed cloud credentials are incomplete; provide broker, username and token together.');
        let region;
        let token;
        if (count === 3) {
            let broker;
            try {
                broker = new URL(credentials[0]);
            }
            catch {
                throw new Error('Cannot determine Bambu account region from the configured broker.');
            }
            if (broker.protocol !== 'mqtts:' || broker.username || broker.password || broker.search || broker.hash || (broker.pathname && broker.pathname !== '/'))
                throw new Error('Cannot determine Bambu account region from the configured broker.');
            if (broker.hostname === 'cn.mqtt.bambulab.com')
                region = 'china';
            else if (['us.mqtt.bambulab.com', 'eu.mqtt.bambulab.com'].includes(broker.hostname))
                region = 'global';
            else
                throw new Error('Cannot determine Bambu account region from the configured broker.');
            token = credentials[2];
        }
        else {
            const session = await this.session(signal, action);
            if (expected && (session.token !== expected.token || session.region !== expected.region || session.identity !== expected.identity || session.authorityEpoch !== expected.authorityEpoch))
                throw new Error('Account authority changed before cloud request.');
            region = session.region;
            token = session.token;
        }
        this.assertAction(action);
        const generation = action.generation;
        const authoritySignal = action.signal;
        const combined = signal ? AbortSignal.any([signal, authoritySignal]) : authoritySignal;
        combined.throwIfAborted();
        const result = await readFilamentLibrary((path, requestSignal) => {
            combined.throwIfAborted();
            this.assertAction(action);
            if (generation !== this.authorityGeneration)
                throw new Error('Account authority changed during inventory read.');
            return this.vendor.request(region, path, undefined, token, requestSignal);
        }, 30000, combined);
        if (generation !== this.authorityGeneration)
            throw new Error('Account authority changed during inventory read.');
        if (count === 0) {
            const current = await this.load();
            if (!current || current.refreshPending || current.region !== region || current.token !== token || await this.authorityEpoch() !== expected?.authorityEpoch)
                throw new Error('Account authority changed during inventory read.');
        }
        this.assertAction(action);
        return result;
    }
    accountTuple(env) {
        return [env.BAMBU_SIGNED_CLOUD_BROKER, env.BAMBU_SIGNED_CLOUD_USERNAME, env.BAMBU_SIGNED_CLOUD_TOKEN];
    }
    async captureAdmission(env, signal, action) {
        this.assertAction(action);
        signal?.throwIfAborted();
        const tuple = this.accountTuple(env), count = tuple.filter(Boolean).length;
        if (count !== 0 && count !== 3)
            throw new Error('Signed cloud credentials are incomplete.');
        if (count === 3)
            return { tuple };
        const epoch = await this.authorityEpoch(), session = await this.load();
        if (epoch !== await this.authorityEpoch() || !session || session.refreshPending)
            throw new Error('Account authority changed or session unavailable.');
        this.assertAction(action);
        signal?.throwIfAborted();
        session.authorityEpoch = epoch;
        return { tuple, session };
    }
    async verifyAdmission(value, env, signal, action) {
        this.assertAction(action);
        signal?.throwIfAborted();
        if (this.accountTuple(env).some((v, i) => v !== value.tuple[i]))
            throw new Error('Account authority changed before cloud request.');
        if (!value.session)
            return undefined;
        const current = await this.load();
        if (!current || current.refreshPending || current.region !== value.session.region || current.token !== value.session.token || current.identity !== value.session.identity || await this.authorityEpoch() !== value.session.authorityEpoch)
            throw new Error('Account authority changed before cloud request.');
        this.assertAction(action);
        signal?.throwIfAborted();
        const generation = action.generation;
        const ready = await this.session(signal, action);
        if (ready.region !== value.session.region || ready.identity !== value.session.identity || ready.authorityEpoch !== value.session.authorityEpoch || (ready.token !== value.session.token && action.generation === generation))
            throw new Error('Account authority changed before cloud request.');
        value.session = ready;
        return ready;
    }
    /** Secret-bearing, single-action capability for owned completed-job reads and one dispatch. */
    async beginCompletedJobAccount(serial, env = process.env, signal) {
        const action = this.beginAction();
        if (!/^[A-Za-z0-9_-]{4,128}$/.test(serial))
            throw new Error('Invalid configured printer.');
        const admission = await this.captureAdmission(env, signal, action);
        const expected = await this.verifyAdmission(admission, env, signal, action);
        if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
            throw new Error('Account authority changed before cloud request.');
        const credentials = await this.getConfiguredCloudMqttCredentials(serial, env, signal, action);
        if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
            throw new Error('Account authority changed before cloud request.');
        if (expected && credentials.password !== expected.token)
            throw new Error('Account authority changed before cloud request.');
        const assertCurrent = async (recheckBinding = false) => {
            this.assertAction(action);
            signal?.throwIfAborted();
            if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
                throw new Error('Account authority changed before cloud request.');
            await credentials.assertCurrent();
            this.assertAction(action);
            if (expected) {
                const current = await this.load();
                if (!current || current.token !== expected.token || current.region !== expected.region || current.identity !== expected.identity || current.refreshPending || await this.authorityEpoch() !== expected.authorityEpoch)
                    throw new Error('Account authority changed before cloud request.');
            }
            this.assertAction(action);
            signal?.throwIfAborted();
            if (recheckBinding) {
                const region = new URL(credentials.url).hostname === 'cn.mqtt.bambulab.com' ? 'china' : 'global';
                const result = await this.vendor.request(region, '/v1/iot-service/api/user/bind', undefined, credentials.password, signal);
                if (!Array.isArray(result.devices) || result.devices.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && item.dev_id === serial).length !== 1)
                    throw new Error('Configured printer is not uniquely bound to this account.');
                await credentials.assertCurrent();
                this.assertAction(action);
                signal?.throwIfAborted();
            }
        };
        const read = async (path) => { await assertCurrent(); const result = await this.performAccountRequest({ method: 'GET', path }, env, signal, action, true, undefined, expected, credentials, admission); await assertCurrent(); return result; };
        let dispatched = false;
        return {
            fetchTask: async (id) => { if (!/^[1-9]\d{0,19}$/.test(id))
                throw new Error('Invalid cloud task.'); return read(`/v1/user-service/my/task/${id}`); },
            fetchProfile: async (modelId, profileId) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(modelId) || !Number.isSafeInteger(profileId) || profileId < 1)
                throw new Error('Invalid cloud profile.'); return read(`/v1/user-service/my/model/profile?profileId=${profileId}&modelId=${encodeURIComponent(modelId)}`); },
            assertCurrent, assertGenerationCurrent: () => { this.assertAction(action); credentials.assertGenerationCurrent(); if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
                throw new Error('Account authority changed before cloud request.'); signal?.throwIfAborted(); },
            withLockedAuthority: async (operation) => withAccountLock(this.directory, async () => {
                this.assertAction(action);
                signal?.throwIfAborted();
                if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
                    throw new Error('Account authority changed before cloud request.');
                if (expected) {
                    const current = await this.load();
                    if (!current || current.refreshPending || current.token !== expected.token || current.region !== expected.region || current.identity !== expected.identity || await this.authorityEpoch() !== expected.authorityEpoch || current.expiresAt !== null && current.expiresAt <= Date.now())
                        throw new Error('Account authority changed before cloud request.');
                }
                const region = new URL(credentials.url).hostname === 'cn.mqtt.bambulab.com' ? 'china' : 'global';
                const binding = await this.vendor.request(region, '/v1/iot-service/api/user/bind', undefined, credentials.password, signal);
                if (!Array.isArray(binding.devices) || binding.devices.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && item.dev_id === serial).length !== 1)
                    throw new Error('Configured printer is not uniquely bound to this account.');
                this.assertAction(action);
                credentials.assertGenerationCurrent();
                signal?.throwIfAborted();
                if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
                    throw new Error('Account authority changed before cloud request.');
                return operation();
            }, signal),
            dispatch: async (payload, headers, onDispatch) => {
                if (dispatched)
                    throw new Error('Cloud dispatch already attempted.');
                await assertCurrent();
                const allowed = ['mode', 'deviceId', 'modelId', 'profileId', 'instanceId', 'plateIndex', 'bedType', 'useAms', 'isPublicProfile', 'amsMapping', 'amsMapping2', 'nozzleMapping', 'amsDetailMapping'];
                if (Object.keys(payload).some(k => !allowed.includes(k)) || payload.mode !== 'auto_repeat' || payload.deviceId !== serial || typeof payload.modelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.modelId) || !Number.isSafeInteger(payload.profileId) || Number(payload.profileId) < 1 || !Number.isSafeInteger(payload.instanceId) || Number(payload.instanceId) < 1 || !Number.isSafeInteger(payload.plateIndex) || Number(payload.plateIndex) < 1 || typeof payload.bedType !== 'string' || !/^[A-Za-z0-9 _-]{1,80}$/.test(payload.bedType) || typeof payload.useAms !== 'boolean' || typeof payload.isPublicProfile !== 'boolean')
                    throw new Error('Invalid completed-job reference.');
                const host = new URL(credentials.url).hostname === 'cn.mqtt.bambulab.com' ? 'https://api.bambulab.cn' : 'https://api.bambulab.com';
                this.assertAction(action);
                signal?.throwIfAborted();
                dispatched = true;
                onDispatch();
                let response;
                try {
                    response = await fetch(host + '/v1/user-service/my/task', { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, action.signal, AbortSignal.timeout(30000)]), headers: { ...headers, authorization: `Bearer ${credentials.password}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
                }
                catch {
                    throw new Error('Cloud dispatch outcome is uncertain; inspect printer and history before retrying.');
                }
                if (!response.ok)
                    throw new Error(`Cloud dispatch returned HTTP ${response.status}; inspect printer and history before retrying.`);
                try {
                    const raw = await responseText(response, 1024 * 1024);
                    const data = JSON.parse(raw, (key, value, context) => { if (key === 'id' && typeof value === 'number' && !Number.isSafeInteger(value)) {
                        if (!context?.source || !/^\d{1,20}$/.test(context.source))
                            throw new Error();
                        return context.source;
                    } return value; });
                    const id = data?.id;
                    if (!data || typeof data !== 'object' || Array.isArray(data) || (data.code != null && data.code !== 0 && data.code !== '0') || (data.error != null && data.error !== '' && data.error !== false) || !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 || typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)))
                        throw new Error();
                    return String(id);
                }
                catch {
                    throw new Error('Cloud dispatch outcome is uncertain; inspect printer and history before retrying.');
                }
            }
        };
    }
    async accountOperationCredentials(env, signal, action) {
        if (action)
            this.assertAction(action);
        const tuple = [env.BAMBU_SIGNED_CLOUD_BROKER?.trim(), env.BAMBU_SIGNED_CLOUD_USERNAME?.trim(), env.BAMBU_SIGNED_CLOUD_TOKEN];
        const count = tuple.filter(Boolean).length;
        if (count !== 0 && count !== 3)
            throw new Error('Signed cloud credentials are incomplete.');
        if (!count) {
            const session = await this.session(signal, action);
            return { region: session.region, token: session.token };
        }
        let broker;
        try {
            broker = new URL(tuple[0]);
        }
        catch {
            throw new Error('Cannot determine cloud account region.');
        }
        if (broker.protocol !== 'mqtts:' || broker.username || broker.password || broker.search || broker.hash || (broker.pathname && broker.pathname !== '/'))
            throw new Error('Cannot determine cloud account region.');
        const region = broker.hostname === 'cn.mqtt.bambulab.com' ? 'china' :
            ['us.mqtt.bambulab.com', 'eu.mqtt.bambulab.com'].includes(broker.hostname) ? 'global' : null;
        if (!region)
            throw new Error('Cannot determine cloud account region.');
        return { region, token: tuple[2] };
    }
    async performAccountRequest(request, env, signal, action, refreshed = false, onRefresh, expected, bound, admission) {
        this.assertAction(action);
        signal?.throwIfAborted();
        if (admission && this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
            throw new Error('Account authority changed before cloud request.');
        const configured = [env.BAMBU_SIGNED_CLOUD_BROKER, env.BAMBU_SIGNED_CLOUD_USERNAME, env.BAMBU_SIGNED_CLOUD_TOKEN];
        if (bound)
            await bound.assertCurrent();
        this.assertAction(action);
        const { region, token } = bound ? { region: new URL(bound.url).hostname === 'cn.mqtt.bambulab.com' ? 'china' : 'global', token: bound.password } : await this.accountOperationCredentials(env, signal, action);
        const session = configured.every(v => !v) ? await this.session(signal, action) : undefined;
        if (session && (session.token !== token || session.region !== region || session.refreshPending))
            throw new Error('Account authority changed before cloud request.');
        if (expected && (!session || session.token !== expected.token || session.region !== expected.region || session.identity !== expected.identity || session.authorityEpoch !== expected.authorityEpoch))
            throw new Error('Account authority changed before cloud request.');
        this.assertAction(action);
        if (admission && this.accountTuple(env).some((v, i) => v !== admission.tuple[i]))
            throw new Error('Account authority changed before cloud request.');
        const generation = action.generation;
        const combined = AbortSignal.any([signal ?? new AbortController().signal, action.signal, AbortSignal.timeout(15000)]);
        combined.throwIfAborted();
        if (generation !== this.authorityGeneration)
            throw new Error('Account authority changed before cloud request.');
        let response;
        const body = request.path.endsWith('/ams/sync') && Array.isArray(request.body?.items)
            ? { ...request.body, items: request.body.items.map((item) => { const { spoolId: _expectedSpoolId, ...wire } = item; return wire; }) }
            : request.body;
        try {
            response = await fetch(regions[region].api + request.path, {
                method: request.method, redirect: 'error', signal: combined,
                headers: { 'user-agent': 'bambu-printer-mcp', 'accept': 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        }
        catch {
            throw new Error(request.method === 'GET' ? 'Bambu cloud read failed.' : 'Bambu cloud write outcome is uncertain; inspect the inventory before retrying.');
        }
        if (response.status === 401 && request.method === 'GET' && !refreshed && !env.BAMBU_SIGNED_CLOUD_BROKER && !env.BAMBU_SIGNED_CLOUD_USERNAME && !env.BAMBU_SIGNED_CLOUD_TOKEN) {
            if (!session)
                throw new Error('Account authority changed before cloud request.');
            const renewed = await this.refreshSession(session, true, signal, action);
            onRefresh?.();
            return this.performAccountRequest(request, env, signal, action, true, onRefresh, renewed, undefined, admission);
        }
        if (!response.ok)
            throw new Error(response.status >= 500 && request.method !== 'GET'
                ? `Bambu cloud returned HTTP ${response.status}; the write outcome is uncertain.`
                : `Bambu cloud returned HTTP ${response.status}.`);
        try {
            const raw = await responseText(response, 1024 * 1024);
            combined.throwIfAborted();
            if (generation !== this.authorityGeneration)
                throw new Error('Account authority changed.');
            if ([env.BAMBU_SIGNED_CLOUD_BROKER, env.BAMBU_SIGNED_CLOUD_USERNAME, env.BAMBU_SIGNED_CLOUD_TOKEN].some((v, i) => v !== configured[i]))
                throw new Error('Account authority changed.');
            if (!env.BAMBU_SIGNED_CLOUD_BROKER && !env.BAMBU_SIGNED_CLOUD_USERNAME && !env.BAMBU_SIGNED_CLOUD_TOKEN) {
                const current = await this.load();
                if (!current || current.refreshPending || current.region !== region || current.token !== token || await this.authorityEpoch() !== session?.authorityEpoch)
                    throw new Error('Account authority changed.');
            }
            this.assertAction(action);
            const result = JSON.parse(raw, (key, value, context) => {
                if (key === 'id' && typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
                    if (!context?.source || !/^\d{1,20}$/.test(context.source))
                        throw new Error('Unsafe cloud task ID.');
                    return context.source;
                }
                return value;
            });
            if (!result || typeof result !== 'object' || Array.isArray(result))
                throw new Error();
            return result;
        }
        catch {
            throw new Error(request.method === 'GET' ? 'Invalid Bambu cloud response.' : 'Bambu cloud write outcome is uncertain; inspect the inventory before retrying.');
        }
    }
    /** Account-only operations are serialized without automatically retrying a mutation. */
    async filamentAction(operation, payload, serial, env = process.env, signal) {
        const action = this.beginAction();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(serial))
            throw new Error('A configured printer serial is required.');
        const request = prepareFilamentAction(operation, payload, serial);
        const admission = await this.captureAdmission(env, signal, action);
        const run = async () => {
            signal?.throwIfAborted();
            this.assertAction(action);
            const expected = await this.verifyAdmission(admission, env, signal, action);
            const response = await this.performAccountRequest(request, env, signal, action, false, undefined, expected, undefined, admission);
            return { operation, status: classifyFilamentResult(operation, request.body, response), data: projectAccountResponse(response) };
        };
        const result = this.accountActions.then(run, run);
        this.accountActions = result.then(() => undefined, () => undefined);
        return result;
    }
    async cloudPrintHistory(serial, env = process.env, signal) {
        const action = this.beginAction();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(serial))
            throw new Error('A configured printer serial is required.');
        const admission = await this.captureAdmission(env, signal, action);
        const run = async () => {
            signal?.throwIfAborted();
            const expected = await this.verifyAdmission(admission, env, signal, action);
            const credentials = await this.accountOperationCredentials(env, signal, action);
            if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]) || expected && (credentials.token !== expected.token || credentials.region !== expected.region))
                throw new Error('Account authority changed before cloud request.');
            const authority = createHash('sha256').update(credentials.region).update('\0').update(credentials.token).digest('hex');
            if (authority !== this.historyAuthority) {
                this.historyAuthority = authority;
                this.historyCached = undefined;
                this.historyLastAttempt = 0;
            }
            const now = Date.now();
            let cached = true;
            if (now - this.historyLastAttempt >= 60000) {
                this.historyLastAttempt = now;
                this.historyCached = undefined;
                cached = false;
                const result = await this.performAccountRequest({ method: 'GET', path: '/v1/user-service/my/tasks' }, env, signal, action, false, undefined, expected, undefined, admission);
                if (!Array.isArray(result.hits) || result.hits.length > 200 || result.hits.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
                    throw new Error('Invalid Bambu history page.');
                const allowed = ['deviceId', 'id', 'title', 'status', 'startTime', 'endTime', 'weight', 'length', 'costTime', 'designId', 'modelId', 'profileId', 'plateIndex', 'mode', 'bedType'];
                const hits = result.hits.map((row) => Object.fromEntries(Object.entries(row).filter(([key, value]) => allowed.includes(key) && (typeof value === 'string' && value.length <= 512 && !value.includes('://') || typeof value === 'number' && Number.isFinite(value)))));
                this.historyCached = { page: { hits, total: Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null }, at: new Date().toISOString() };
            }
            if (!this.historyCached)
                throw new Error('Cloud history is unavailable; wait for the account read interval.');
            const { page, at } = this.historyCached;
            const hits = page.hits;
            const tasks = hits.filter(row => row.deviceId === serial).map(({ deviceId, ...row }) => row);
            return { tasks, retrieved_at: at, cached, account_page_count: hits.length, account_reported_total: page.total, page_scope: 'first_upstream_account_page', complete_account_history: page.total !== null && page.total === hits.length };
        };
        const result = this.accountActions.then(run, run);
        this.accountActions = result.then(() => undefined, () => undefined);
        return result;
    }
    /** One bounded printer-filtered upstream page; the caller carries next_offset. */
    async cloudPrintHistoryPage(serial, options = {}, env = process.env, signal) {
        const action = this.beginAction();
        const page = historyPageRequest(serial, options);
        const admission = await this.captureAdmission(env, signal, action);
        const run = async () => {
            signal?.throwIfAborted();
            this.assertAction(action);
            const expected = await this.verifyAdmission(admission, env, signal, action);
            let credentials = await this.getConfiguredCloudMqttCredentials(serial, env, signal, action);
            await credentials.assertCurrent();
            if (this.accountTuple(env).some((v, i) => v !== admission.tuple[i]) || expected && credentials.password !== expected.token)
                throw new Error('Account authority changed before cloud request.');
            const cacheKey = () => createHash('sha256').update(credentials.url).update('\0').update(credentials.username).update('\0').update(credentials.password).update('\0').update(page.path).digest('hex');
            let key = cacheKey();
            const existing = this.historyPages.get(key);
            if (existing && Date.now() - existing.at < 60000) {
                this.historyPages.delete(key);
                this.historyPages.set(key, existing);
                return { ...structuredClone(existing.value), cached: true };
            }
            this.historyPages.delete(key);
            let refreshed = false;
            const response = await this.performAccountRequest({ method: 'GET', path: page.path }, env, signal, action, false, () => { refreshed = true; }, expected, credentials, admission);
            if (refreshed) {
                const next = await this.getConfiguredCloudMqttCredentials(serial, env, signal, action);
                if (next.username !== credentials.username || next.url !== credentials.url)
                    throw new Error('Account authority changed during cloud read.');
                credentials = next;
                key = cacheKey();
            }
            await credentials.assertCurrent();
            const value = { ...projectHistoryPage(response, serial, page.offset, page.limit), retrieved_at: new Date().toISOString(), cached: false, page_scope: 'printer_filtered_page', account_reported_total: null, complete_account_history: false };
            this.historyPages.set(key, { value: structuredClone(value), at: Date.now() });
            while (this.historyPages.size > 16)
                this.historyPages.delete(this.historyPages.keys().next().value);
            return value;
        };
        const result = this.accountActions.then(run, run);
        this.accountActions = result.then(() => undefined, () => undefined);
        return result;
    }
    async cloudPrintHistoryCover(serial, taskId, env = process.env, signal) {
        const action = this.beginAction();
        const id = typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0 ? String(taskId) : typeof taskId === 'string' && /^[1-9]\d{0,19}$/.test(taskId) ? taskId : '';
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(serial) || !id)
            throw new Error('Invalid cloud task.');
        let credentials = await this.getConfiguredCloudMqttCredentials(serial, env, signal, action);
        await credentials.assertCurrent();
        let refreshed = false;
        const task = await this.performAccountRequest({ method: 'GET', path: `/v1/user-service/my/task/${id}` }, env, signal, action, false, () => { refreshed = true; }, undefined, credentials);
        if (refreshed) {
            const next = await this.getConfiguredCloudMqttCredentials(serial, env, signal, action);
            if (next.username !== credentials.username || next.url !== credentials.url)
                throw new Error('Account authority changed during cloud read.');
            credentials = next;
        }
        await credentials.assertCurrent();
        if (String(task.id) !== id || task.deviceId !== serial)
            throw new Error('Cloud task does not belong to the selected printer.');
        const result = await readHistoryCover(task.cover, signal);
        await credentials.assertCurrent();
        return result;
    }
    async listPrinters() {
        const action = this.beginAction();
        const session = await this.session(undefined, action);
        this.assertAction(action);
        try {
            return await this.boundPrinters(session, undefined, action);
        }
        catch (e) {
            if (!(e instanceof AccountAuthenticationError))
                throw e;
            return this.boundPrinters(await this.refreshSession(session, true, undefined, action), undefined, action);
        }
    }
    async boundPrinters(s, signal, action) {
        if (action)
            this.assertAction(action);
        const result = await this.vendor.request(s.region, '/v1/iot-service/api/user/bind', undefined, s.token, signal);
        signal?.throwIfAborted();
        const current = await this.load();
        if (!current || current.refreshPending || current.token !== s.token || current.region !== s.region || await this.authorityEpoch() !== s.authorityEpoch)
            throw new Error('Account authority changed during binding read.');
        if (action)
            this.assertAction(action);
        if (!Array.isArray(result.devices))
            throw new Error('Bambu returned an invalid printer list.');
        return result.devices.map((device) => {
            if (!device || typeof device !== 'object')
                throw new Error('Bambu returned an invalid printer list.');
            const d = device;
            if (!shortString(d.dev_id))
                throw new Error('Bambu returned an invalid printer identity.');
            return { serial: d.dev_id, name: typeof d.name === 'string' ? d.name : '', model: typeof d.dev_product_name === 'string' ? d.dev_product_name : typeof d.dev_model_name === 'string' ? d.dev_model_name : '' };
        });
    }
    /** Secret-bearing adapter boundary. Never return this object from an MCP tool. */
    async getCloudMqttCredentials(serial, signal, action = this.beginAction()) {
        this.assertAction(action);
        if (!shortString(serial))
            throw new Error('A configured printer serial is required.');
        const session = await this.session(signal, action);
        try {
            return await this.cloudMqttCredentialsForSession(serial, session, signal, action);
        }
        catch (e) {
            if (!(e instanceof AccountAuthenticationError))
                throw e;
            return this.cloudMqttCredentialsForSession(serial, await this.refreshSession(session, true, signal, action), signal, action);
        }
    }
    async cloudMqttCredentialsForSession(serial, s, signal, action) {
        if (!shortString(serial))
            throw new Error('A configured printer serial is required.');
        this.assertAction(action);
        const generation = action.generation;
        signal?.throwIfAborted();
        const bound = await this.boundPrinters(s, signal, action);
        if (bound.filter(p => p.serial === serial).length !== 1)
            throw new Error('Configured printer is not uniquely bound to this account.');
        this.assertAction(action);
        let username;
        const parts = s.token.split('.');
        if (parts.length === 3) {
            let payload;
            try {
                payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            }
            catch {
                throw new Error('Bambu returned an invalid account identity.');
            }
            if (!payload || typeof payload.username !== 'string' || !/^u_\d{1,20}$/.test(payload.username))
                throw new Error('Bambu returned an invalid account identity.');
            username = payload.username;
        }
        else {
            const pref = await this.vendor.request(s.region, '/v1/design-user-service/my/preference', undefined, s.token, signal);
            if (typeof pref.uid === 'number' && !Number.isSafeInteger(pref.uid))
                throw new Error('Bambu returned an invalid account identity.');
            const uid = String(pref.uid ?? '');
            if (!/^\d{1,20}$/.test(uid))
                throw new Error('Bambu returned an invalid account identity.');
            username = `u_${uid}`;
        }
        const assertGenerationCurrent = () => {
            this.assertAction(action);
            if (generation !== this.authorityGeneration)
                throw new Error('Account authority changed; obtain fresh cloud credentials.');
        };
        const assertCurrent = async () => {
            assertGenerationCurrent();
            const current = await this.session(signal);
            if (generation !== this.authorityGeneration || current.token !== s.token || current.region !== s.region || current.identity !== s.identity || current.expiresAt !== s.expiresAt || current.authorityEpoch !== s.authorityEpoch)
                throw new Error('Account authority changed; obtain fresh cloud credentials.');
        };
        await assertCurrent();
        return { url: regions[s.region].mqtt, username, password: s.token, assertCurrent, assertGenerationCurrent };
    }
    /**
     * Resolve the configured cloud writer's account identity for internal adapters.
     * A complete explicit tuple has precedence over an interactive account session.
     */
    async getConfiguredCloudMqttCredentials(serial, env = process.env, signal, action = this.beginAction()) {
        this.assertAction(action);
        if (!shortString(serial))
            throw new Error('A configured printer serial is required.');
        const readTuple = () => [
            env.BAMBU_SIGNED_CLOUD_BROKER?.trim(),
            env.BAMBU_SIGNED_CLOUD_USERNAME?.trim(),
            env.BAMBU_SIGNED_CLOUD_TOKEN,
        ];
        const tuple = readTuple();
        const count = tuple.filter(Boolean).length;
        if (count === 0) {
            if (signal?.aborted)
                throw new Error('Cloud account request cancelled.');
            const result = await this.getCloudMqttCredentials(serial, signal, action);
            if (signal?.aborted)
                throw new Error('Cloud account request cancelled.');
            if (readTuple().some(Boolean))
                throw new Error('Cloud configuration changed; obtain fresh cloud credentials.');
            const assertGenerationCurrent = () => {
                if (signal?.aborted)
                    throw new Error('Cloud account request cancelled.');
                if (readTuple().some(Boolean))
                    throw new Error('Cloud configuration changed; obtain fresh cloud credentials.');
                result.assertGenerationCurrent();
            };
            const assertCurrent = async () => {
                assertGenerationCurrent();
                await result.assertCurrent();
                assertGenerationCurrent();
            };
            return { ...result, assertCurrent, assertGenerationCurrent };
        }
        if (count !== 3)
            throw new Error('Signed cloud credentials are incomplete; provide broker, username and token together.');
        let broker;
        try {
            broker = new URL(tuple[0]);
        }
        catch {
            throw new Error('Configured cloud broker is invalid.');
        }
        const region = broker.hostname === 'cn.mqtt.bambulab.com' ? 'china'
            : ['us.mqtt.bambulab.com', 'eu.mqtt.bambulab.com'].includes(broker.hostname) ? 'global' : null;
        if (!region || broker.protocol !== 'mqtts:' || (broker.port !== '' && broker.port !== '8883')
            || broker.username || broker.password || broker.search || broker.hash
            || (broker.pathname !== '' && broker.pathname !== '/')) {
            throw new Error('Configured cloud broker is invalid.');
        }
        const username = tuple[1];
        const password = tuple[2];
        if (!/^u_\d{1,20}$/.test(username) || !shortString(password) || /\s/.test(password)) {
            throw new Error('Configured cloud credentials are invalid.');
        }
        const assertGenerationCurrent = () => {
            this.assertAction(action);
            if (signal?.aborted)
                throw new Error('Cloud account request cancelled.');
            const current = readTuple();
            if (current.some((value, index) => value !== tuple[index])) {
                throw new Error('Cloud configuration changed; obtain fresh cloud credentials.');
            }
        };
        assertGenerationCurrent();
        let result;
        try {
            result = await this.vendor.request(region, '/v1/iot-service/api/user/bind', undefined, password, signal);
        }
        catch {
            assertGenerationCurrent();
            throw new Error('Bambu account binding request failed.');
        }
        assertGenerationCurrent();
        if (!Array.isArray(result.devices)
            || result.devices.filter((item) => item && typeof item === 'object'
                && !Array.isArray(item) && item.dev_id === serial).length !== 1) {
            throw new Error('Configured printer is not uniquely bound to this account.');
        }
        const assertCurrent = async () => { assertGenerationCurrent(); };
        return {
            url: `mqtts://${broker.hostname}:8883`,
            username,
            password,
            assertCurrent,
            assertGenerationCurrent,
        };
    }
    async logout() {
        this.logoutInProgress++;
        this.invalidateAuthority();
        this.cancelInteractiveLogin();
        // Local removal only; deliberately does not revoke the remote session.
        try {
            await this.enqueueWrite(async () => withAccountLock(this.directory, async () => {
                await this.advanceEpoch();
                const s = await this.load();
                if (s)
                    await fs.unlink(this.file);
                const dir = await fs.open(this.directory, 'r');
                try {
                    await dir.sync();
                }
                finally {
                    await dir.close();
                }
                this.invalidateAuthority();
            }));
        }
        finally {
            this.logoutInProgress--;
        }
    }
    cancelInteractiveLogin() {
        this.flowGeneration++;
        this.starting = undefined;
        const current = this.active;
        if (!current)
            return;
        this.active = undefined;
        clearTimeout(current.timer);
        current.server.close();
        current.server.closeAllConnections?.();
    }
    async beginInteractiveLogin({ region }) {
        if (this.logoutInProgress)
            throw new Error('Account logout in progress.');
        if (!isRegion(region))
            throw new Error('Choose global or china account region.');
        if (this.active || this.starting)
            throw new Error('A login flow is already active.');
        const flowId = randomBytes(32).toString('hex');
        const flowGeneration = this.flowGeneration;
        this.starting = { flowId };
        let flowEpoch;
        try {
            flowEpoch = await withAccountLock(this.directory, () => this.authorityEpoch());
        }
        catch (e) {
            if (this.starting?.flowId === flowId)
                this.starting = undefined;
            throw e;
        }
        if (this.starting?.flowId !== flowId || this.flowGeneration !== flowGeneration)
            throw new Error('Login flow cancelled.');
        const expiresAt = Date.now() + 5 * 60000;
        let account = '';
        let tfaKey = '';
        let challenge = '';
        let busy = false;
        let port = 0;
        const server = createServer(async (req, res) => {
            try {
                const expected = `127.0.0.1:${port}`;
                if (Date.now() >= expiresAt || req.headers.host !== expected || req.url !== `/${flowId}` || !['GET', 'POST'].includes(req.method ?? ''))
                    return reply(res, 403, 'Forbidden');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                if (req.method === 'GET') {
                    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    return reply(res, 200, page);
                }
                if (req.headers.origin !== `http://${expected}` || req.headers['content-type'] !== 'application/json' || busy)
                    return reply(res, 403, 'Forbidden');
                busy = true;
                try {
                    const data = await readBody(req);
                    let response;
                    if (data.action === 'cancel') {
                        reply(res, 200, JSON.stringify({ state: 'cancelled' }));
                        this.cancelInteractiveLogin();
                        return;
                    }
                    if (!challenge && data.action === 'login' && shortString(data.account) && shortString(data.password)) {
                        account = data.account;
                        response = await this.vendor.request(region, '/v1/user-service/user/login', { account, password: data.password, apiError: '' });
                    }
                    else if (challenge === 'email' && data.action === 'resend') {
                        if (account.includes('@'))
                            await this.vendor.request(region, '/v1/user-service/user/sendemail/code', { email: account, type: 'codeLogin' });
                        else if (region === 'china' && this.vendor.resendPhone)
                            await this.vendor.resendPhone(account);
                        else
                            throw new Error('Phone code requests require a China account.');
                        return json(res, { state: 'email', message: 'A new verification code was requested.' });
                    }
                    else if (challenge && data.action === 'verify' && typeof data.code === 'string' && /^\d{6,10}$/.test(data.code)) {
                        response = challenge === 'email'
                            ? await this.vendor.request(region, '/v1/user-service/user/login', { account, code: data.code })
                            : await (this.vendor.verifyTotp ? this.vendor.verifyTotp(region, tfaKey, data.code) : Promise.reject(new Error('Authenticator verification unavailable.')));
                    }
                    else
                        throw new Error('Invalid login request.');
                    if (response.loginType === 'verifyCode') {
                        challenge = 'email';
                        return json(res, { state: 'email' });
                    }
                    if (response.loginType === 'tfa' && shortString(response.tfaKey)) {
                        challenge = 'totp';
                        tfaKey = response.tfaKey;
                        return json(res, { state: 'totp' });
                    }
                    if (!shortString(response.accessToken))
                        throw new Error('Bambu did not accept the login or verification code.');
                    const seconds = response.expiresIn === undefined ? null : Number(response.expiresIn);
                    if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 366 * 86400))
                        throw new Error('Bambu returned an invalid session expiry.');
                    const refreshToken = response.refreshToken;
                    if (refreshToken !== undefined && refreshToken !== null && !shortString(refreshToken))
                        throw new Error('Bambu returned an invalid session expiry.');
                    const refreshSeconds = response.refreshExpiresIn === undefined || response.refreshExpiresIn === null ? null : Number(response.refreshExpiresIn);
                    if (refreshSeconds !== null && (!Number.isFinite(refreshSeconds) || refreshSeconds <= 0 || refreshSeconds > 366 * 86400))
                        throw new Error('Bambu returned an invalid session expiry.');
                    const identity = shortString(refreshToken) ? await this.identity(region, response.accessToken) : undefined;
                    if (!this.active || this.active.flowId !== flowId || Date.now() >= expiresAt)
                        throw new Error('Login flow expired.');
                    await this.save({ version: 1, region, token: response.accessToken, expiresAt: seconds === null ? null : Math.floor(Date.now() + seconds * 1000), ...(shortString(refreshToken) ? { refreshToken, identity, refreshExpiresAt: refreshSeconds === null ? null : Math.floor(Date.now() + refreshSeconds * 1000) } : {}) }, () => this.flowGeneration === flowGeneration && this.active?.flowId === flowId && Date.now() < expiresAt, flowEpoch);
                    json(res, { state: 'complete' });
                    // Let the successful response finish before closing the listener.
                    res.once('finish', () => { if (this.active?.flowId === flowId)
                        this.cancelInteractiveLogin(); });
                }
                catch (e) {
                    const known = e instanceof Error && ['Bambu rate limit reached; try again later.', 'Bambu rejected the request.', 'Bambu response too large.', 'Bambu request failed or timed out.', 'Bambu did not accept the login or verification code.', 'Bambu returned an invalid session expiry.', 'Incorrect authenticator code.', 'Bambu verification is blocked or unavailable.', 'Bambu verification is blocked or rate limited.', 'Bambu verification failed.', 'Bambu did not provide an account token.', 'Authenticator verification unavailable.', 'Phone code requests require a China account.', 'Bambu rejected the code request.', 'Verification code expired.', 'Incorrect verification code.', 'Login flow expired.', 'Invalid login request.'].includes(e.message);
                    json(res, { state: 'error', message: known ? e.message : 'Login failed; check local session permissions and try again.' }, 400);
                }
                finally {
                    busy = false;
                }
            }
            catch {
                reply(res, 400, 'Invalid request');
            }
        });
        server.requestTimeout = 15000;
        server.headersTimeout = 10000;
        try {
            await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolvePromise(); }); });
        }
        finally {
            if (this.starting?.flowId === flowId)
                this.starting = undefined;
        }
        if (this.flowGeneration !== flowGeneration) {
            server.close();
            server.closeAllConnections?.();
            throw new Error('Login flow cancelled.');
        }
        port = server.address().port;
        const timer = setTimeout(() => { if (this.active?.flowId === flowId)
            this.cancelInteractiveLogin(); }, Math.max(0, expiresAt - Date.now()));
        timer.unref();
        this.active = { server, flowId, expiresAt, timer };
        return { flowId, url: `http://127.0.0.1:${port}/${flowId}`, expiresAt: new Date(expiresAt).toISOString() };
    }
}
async function responseText(response, limit) {
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new Error('Bambu response too large.');
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
function reply(res, status, body) { res.statusCode = status; res.end(body); }
function json(res, value, status = 200) { res.setHeader('Content-Type', 'application/json'); reply(res, status, JSON.stringify(value)); }
async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > 8192)
            throw new Error('Request too large.');
        chunks.push(b);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('Invalid request.');
    return data;
}
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Bambu account sign in</title></head><body><h1>Bambu account sign in</h1><p>Enter credentials on this server's local browser. They are sent directly to Bambu; your password is not saved.</p><form id="login"><label>Username, email or phone <input name="account" autocomplete="username" required></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required></label><br><button>Sign in</button></form><form id="verify" hidden><label id="label">Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Verify</button><button type="button" id="resend" hidden>Request another verification code</button></form><button id="cancel">Cancel</button><p id="status" role="status"></p><script>
const send=async x=>{const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)});return r.json()}; const status=document.querySelector('#status');
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const r=await send({action:'login',account:f.account.value,password:f.password.value});f.password.value='';show(r)}catch{f.password.value='';status.textContent='Login request failed.'}};
document.querySelector('#verify').onsubmit=async e=>{e.preventDefault();const f=e.target;try{const r=await send({action:'verify',code:f.code.value});f.code.value='';show(r)}catch{f.code.value='';status.textContent='Verification request failed.'}};
document.querySelector('#resend').onclick=async()=>{try{show(await send({action:'resend'}))}catch{status.textContent='Request failed.'}};function show(r){status.textContent=r.message||'';if(r.state==='email'||r.state==='totp'){document.querySelector('#login').hidden=true;document.querySelector('#verify').hidden=false;document.querySelector('#resend').hidden=r.state!=='email';status.textContent=r.state==='email'?'Enter the code sent by Bambu.':'Enter the code from your authenticator.'}if(r.state==='complete'){document.querySelector('#login').hidden=true;document.querySelector('#verify').hidden=true;document.querySelector('#cancel').hidden=true;status.textContent='Signed in. You can close this page.'}}document.querySelector('#cancel').onclick=async()=>{try{await send({action:'cancel'})}finally{document.body.textContent='Login cancelled.'}};
</script></body></html>`;
