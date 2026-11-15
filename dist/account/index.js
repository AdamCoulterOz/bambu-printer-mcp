import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
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
    async request(region, path, body, token) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 15000);
        try {
            const response = await fetch(regions[region].api + path, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: abort.signal,
                headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!response.ok) {
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
            if (e instanceof Error && ['Bambu rate limit reached; try again later.', 'Bambu rejected the request.', 'Bambu response too large.', 'Invalid Bambu response.', 'Verification code expired.', 'Incorrect verification code.'].includes(e.message))
                throw e;
            throw new Error('Bambu request failed or timed out.');
        }
        finally {
            clearTimeout(timer);
        }
    }
}
const isRegion = (value) => value === 'global' || value === 'china';
const shortString = (x) => typeof x === 'string' && x.length > 0 && x.length <= 2048;
export class AccountManager {
    constructor(options = {}) {
        this.flowGeneration = 0;
        this.authorityGeneration = 0;
        this.writes = Promise.resolve();
        this.directory = resolve(options.sessionDirectory ?? join(homedir(), '.config', 'bambu-printer-mcp', 'account'));
        this.vendor = options.vendor ?? new HttpVendor();
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
            if (s.version !== 1 || !isRegion(s.region) || !shortString(s.token) || !(s.expiresAt === null || Number.isSafeInteger(s.expiresAt)))
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
        const s = await this.load();
        return { state: !s ? 'not_configured' : s.expiresAt !== null && s.expiresAt <= Date.now() ? 'expired' : 'ready', ...(s ? { region: s.region, ...(s.expiresAt === null ? {} : { expiresAt: new Date(s.expiresAt).toISOString() }) } : {}), loginInProgress: !!this.active || !!this.starting };
    }
    enqueueWrite(work) {
        const result = this.writes.then(work);
        this.writes = result.then(() => undefined, () => undefined);
        return result;
    }
    async save(session, isActive) {
        // Invalidate queued credentials before beginning account rotation.
        this.authorityGeneration++;
        return this.enqueueWrite(async () => {
            if (!isActive())
                throw new Error('Login flow expired.');
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
                else
                    await fs.unlink(this.file).catch(e => { if (e.code !== 'ENOENT')
                        throw e; });
                throw new Error('Login flow expired.');
            }
            this.authorityGeneration++;
        });
    }
    async session() {
        const s = await this.load();
        if (!s || (s.expiresAt !== null && s.expiresAt <= Date.now()))
            throw new Error('Account session missing or expired; sign in again.');
        return s;
    }
    async listPrinters() {
        return this.boundPrinters(await this.session());
    }
    async boundPrinters(s) {
        const result = await this.vendor.request(s.region, '/v1/iot-service/api/user/bind', undefined, s.token);
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
    async getCloudMqttCredentials(serial) {
        if (!shortString(serial))
            throw new Error('A configured printer serial is required.');
        const generation = this.authorityGeneration;
        const s = await this.session();
        const bound = await this.boundPrinters(s);
        if (bound.filter(p => p.serial === serial).length !== 1)
            throw new Error('Configured printer is not uniquely bound to this account.');
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
            const pref = await this.vendor.request(s.region, '/v1/design-user-service/my/preference', undefined, s.token);
            if (typeof pref.uid === 'number' && !Number.isSafeInteger(pref.uid))
                throw new Error('Bambu returned an invalid account identity.');
            const uid = String(pref.uid ?? '');
            if (!/^\d{1,20}$/.test(uid))
                throw new Error('Bambu returned an invalid account identity.');
            username = `u_${uid}`;
        }
        const assertGenerationCurrent = () => {
            if (generation !== this.authorityGeneration)
                throw new Error('Account authority changed; obtain fresh cloud credentials.');
        };
        const assertCurrent = async () => {
            assertGenerationCurrent();
            const current = await this.session();
            if (generation !== this.authorityGeneration || current.token !== s.token || current.region !== s.region || current.expiresAt !== s.expiresAt)
                throw new Error('Account authority changed; obtain fresh cloud credentials.');
        };
        await assertCurrent();
        return { url: regions[s.region].mqtt, username, password: s.token, assertCurrent, assertGenerationCurrent };
    }
    async logout() {
        this.authorityGeneration++;
        this.cancelInteractiveLogin();
        // Local removal only; deliberately does not revoke the remote session.
        await this.enqueueWrite(async () => {
            const s = await this.load();
            if (s)
                await fs.unlink(this.file);
        });
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
        if (!isRegion(region))
            throw new Error('Choose global or china account region.');
        if (this.active || this.starting)
            throw new Error('A login flow is already active.');
        const flowId = randomBytes(32).toString('hex');
        const flowGeneration = this.flowGeneration;
        this.starting = { flowId };
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
                    if (!this.active || this.active.flowId !== flowId || Date.now() >= expiresAt)
                        throw new Error('Login flow expired.');
                    await this.save({ version: 1, region, token: response.accessToken, expiresAt: seconds === null ? null : Math.floor(Date.now() + seconds * 1000) }, () => this.flowGeneration === flowGeneration && this.active?.flowId === flowId && Date.now() < expiresAt);
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
