import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InitializeRequestSchema, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, isJSONRPCRequest, isJSONRPCNotification, isJSONRPCResultResponse, isJSONRPCErrorResponse, CancelledNotificationSchema, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { ActiveOperation } from './http-operation.js';
import { createModernHttpAdapter } from './http-modern.js';
import { isLegacyRequest } from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { handleWorkspaceArtifactUpload } from './workspace-artifacts.js';
const key = (nonce, id) => `${nonce}:${typeof id}:${String(id)}`;
const reject = (res, code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
async function readBody(req, maximum) {
    if (Number(req.headers['content-length']) > maximum)
        throw Object.assign(new Error('too large'), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > maximum)
            throw Object.assign(new Error('too large'), { status: 413 });
        chunks.push(b);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw Object.assign(new Error('invalid json'), { status: 400 });
    }
}
export class HttpRequests {
    constructor(options, factory) {
        this.options = options;
        this.factory = factory;
        this.httpServer = createServer((req, res) => { void this.handle(req, res); });
        this.secret = randomBytes(32);
        this.active = new Map();
        this.prompts = new Map();
        this.admitted = 0;
        this.pending = 0;
        this.httpRequests = 0;
        this.controls = 0;
        this.denials = 0;
        this.closing = false;
        const loopback = ['127.0.0.1', 'localhost', '::1'].includes(options.host);
        if (!loopback && !options.bearerToken)
            throw new Error('Non-loopback HTTP requires an explicit bearer token.');
        if (!loopback && !isIP(options.host) && !options.allowedHosts?.size)
            throw new Error('Non-loopback HTTP hostname binding requires MCP_HTTP_ALLOWED_HOSTS.');
        if (['0.0.0.0', '::'].includes(options.host) && !options.allowedHosts?.size)
            throw new Error('Wildcard HTTP binding requires MCP_HTTP_ALLOWED_HOSTS.');
        this.modern = createModernHttpAdapter({ createProtocolServer: factory, createOperation: operation => this.createOperation(operation), pendingTimeoutMs: options.modernPendingTimeoutMs, reserveOperation: () => this.reserveOperation(), serverInfo: options.serverInfo, instructions: options.instructions });
        this.modernNode = toNodeHandler({ fetch: (request, opts) => this.modern.fetch(request, { ...opts, authInfo: { token: '', clientId: options.bearerToken ? 'bearer-operator' : 'loopback-anonymous', scopes: [] } }) });
        this.httpServer.requestTimeout = 30000;
        this.httpServer.headersTimeout = 15000;
    }
    createOperation(options) {
        return new ActiveOperation({ ...options, abortGraceMs: this.options.abortGraceMs, onUnsettled: this.options.onUnsettled });
    }
    reserveOperation() {
        if (this.closing || this.admitted >= 128)
            return undefined;
        this.admitted++;
        let released = false;
        return () => { if (!released) {
            released = true;
            this.admitted--;
        } };
    }
    stats() { return { activeRequests: this.active.size, admittedOperations: this.admitted, modern: this.modern.stats(), pendingInitializations: this.pending, pendingInputs: this.prompts.size, controlRequests: this.controls, denials: this.denials }; }
    async listen() { await new Promise((resolve, rejectListen) => { this.httpServer.once('error', rejectListen); this.httpServer.listen(this.options.port, this.options.host, () => { this.httpServer.off('error', rejectListen); resolve(); }); }); }
    ticket(claims) { const body = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`; }
    verify(value) {
        if (value.length > 8192)
            return;
        const [body, signature, ...rest] = value.split('.');
        if (!body || !signature || rest.length)
            return;
        const expected = createHmac('sha256', this.secret).update(body).digest();
        let actual;
        try {
            actual = Buffer.from(signature, 'base64url');
        }
        catch {
            return;
        }
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            return;
        try {
            const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!/^[a-f0-9]{32}$/.test(claim.nonce))
                return;
            const parsed = InitializeRequestSchema.safeParse({ jsonrpc: '2.0', id: 0, method: 'initialize', params: claim.params });
            if (!parsed.success)
                return;
            return { nonce: claim.nonce, params: parsed.data.params };
        }
        catch {
            return;
        }
    }
    validHost(host) {
        if (!host)
            return false;
        if (this.options.allowedHosts?.size)
            return this.options.allowedHosts.has(host);
        const addr = this.httpServer.address();
        const port = addr && typeof addr !== 'string' ? addr.port : this.options.port;
        const names = ['127.0.0.1', 'localhost', '::1'].includes(this.options.host) ? ['127.0.0.1', 'localhost', '[::1]'] : [isIP(this.options.host) === 6 ? `[${this.options.host}]` : this.options.host];
        return names.some(n => host === `${n}:${port}` || (port === 80 && host === n));
    }
    denied(res, status, message) { this.denials++; reject(res, status, message); }
    async handle(req, res) {
        try {
            if (this.closing)
                return this.denied(res, 503, 'Server shutting down');
            if (!this.validHost(req.headers.host))
                return this.denied(res, 403, 'Forbidden host');
            const origin = req.headers.origin;
            if (origin !== undefined && !this.options.allowedOrigins.has(origin))
                return this.denied(res, 403, 'Forbidden origin');
            const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
            if (requestPath !== this.options.path && !requestPath.startsWith(`${this.options.path}/workspace-uploads/`))
                return this.denied(res, 404, 'Not found');
            if (req.method === 'OPTIONS') {
                if (origin) {
                    res.setHeader('Access-Control-Allow-Origin', origin);
                    res.setHeader('Vary', 'Origin');
                }
                res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
                res.writeHead(204);
                res.end();
                return;
            }
            if (this.options.bearerToken) {
                const a = Buffer.from(req.headers.authorization ?? '');
                const b = Buffer.from(`Bearer ${this.options.bearerToken}`);
                if (a.length !== b.length || !timingSafeEqual(a, b)) {
                    res.setHeader('WWW-Authenticate', 'Bearer');
                    return this.denied(res, 401, 'Unauthorized');
                }
            }
            // The public gateway authenticates this capability route and injects the
            // backend bearer. It is deliberately a raw upload, not an MCP JSON call.
            if (await handleWorkspaceArtifactUpload(req, res))
                return;
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
            }
            res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST, OPTIONS');
                return this.denied(res, 405, 'Method not allowed');
            }
            if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
                return this.denied(res, 415, 'Unsupported media type');
            if (this.httpRequests >= 136)
                return this.denied(res, 503, 'Too many HTTP requests');
            this.httpRequests++;
            let released = false;
            const release = () => { if (!released) {
                released = true;
                this.httpRequests--;
            } };
            res.once('close', release);
            res.once('finish', release);
            const body = await readBody(req, this.options.maxBodyBytes ?? 4 * 1024 * 1024);
            if (this.closing || res.destroyed)
                return;
            const probe = await toWebRequest(req, body);
            if (!await isLegacyRequest(probe, body)) {
                await this.modernNode(req, res, body);
                return;
            }
            if (!(req.headers.accept ?? '').includes('application/json') || !(req.headers.accept ?? '').includes('text/event-stream'))
                return this.denied(res, 406, 'Not acceptable');
            const init = InitializeRequestSchema.safeParse(body);
            if (init.success) {
                if (this.pending >= 128 || this.active.size >= 128)
                    return this.denied(res, 503, 'Too many active requests');
                if (req.headers['mcp-session-id'])
                    return this.denied(res, 400, 'Already initialized');
                const params = { ...init.data.params, protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(init.data.params.protocolVersion) ? init.data.params.protocolVersion : LATEST_PROTOCOL_VERSION };
                const ticket = this.ticket({ nonce: randomBytes(16).toString('hex'), params });
                if (ticket.length > 8192)
                    return this.denied(res, 413, 'Client metadata too large');
                const server = this.factory();
                this.pending++;
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: this.options.enableJsonResponse });
                const cleanup = () => { this.pending--; void server.close(); };
                let settled = false;
                const finish = () => { if (!settled) {
                    settled = true;
                    cleanup();
                } };
                res.once('finish', finish);
                res.once('close', finish);
                try {
                    await server.connect(transport);
                    if (settled || res.destroyed) {
                        await server.close();
                        return;
                    }
                    res.setHeader('Mcp-Session-Id', ticket);
                    await transport.handleRequest(req, res, body);
                }
                catch (e) {
                    finish();
                    throw e;
                }
                return;
            }
            const raw = req.headers['mcp-session-id'];
            if (typeof raw !== 'string')
                return this.denied(res, 400, 'Initialize first');
            const claims = this.verify(raw);
            if (!claims)
                return this.denied(res, 404, 'Unknown session');
            const messages = Array.isArray(body) ? body : [body];
            if (!messages.length)
                return this.denied(res, 400, 'Invalid request');
            const isControl = messages.every(m => (isJSONRPCNotification(m) && CancelledNotificationSchema.safeParse(m).success) || isJSONRPCResultResponse(m) || isJSONRPCErrorResponse(m));
            if (isControl) {
                if (this.controls >= 8)
                    return this.denied(res, 503, 'Too many control requests');
                this.controls++;
                try {
                    for (const m of messages) {
                        const cancel = CancelledNotificationSchema.safeParse(m);
                        if (cancel.success) {
                            const id = cancel.data.params.requestId;
                            const op = id === undefined ? undefined : this.active.get(key(claims.nonce, id));
                            if (op && id !== undefined)
                                op.operation.abort();
                        }
                        else if (isJSONRPCResultResponse(m) || isJSONRPCErrorResponse(m)) {
                            const item = typeof m.id === 'string' ? this.prompts.get(m.id) : undefined;
                            if (item && item.nonce === claims.nonce) {
                                this.prompts.delete(m.id);
                                item.operation.operation.respond(m.id, m);
                            }
                        }
                    }
                    res.writeHead(202);
                    res.end();
                }
                finally {
                    this.controls--;
                }
                return;
            }
            if (messages.some(m => !isJSONRPCRequest(m))) {
                if (messages.length === 1 && isJSONRPCNotification(messages[0]) && messages[0].method === 'notifications/initialized') {
                    res.writeHead(202);
                    res.end();
                    return;
                }
                return this.denied(res, 400, 'Invalid message batch');
            }
            const checked = messages.map(message => JSONRPCMessageSchema.safeParse(message));
            if (checked.some(result => !result.success || !isJSONRPCRequest(result.data)))
                return this.denied(res, 400, 'Invalid JSON-RPC request');
            const requests = checked.map(result => result.data);
            const ids = requests.map(request => request.id);
            if (new Set(ids).size !== ids.length || ids.some(id => this.active.has(key(claims.nonce, id))))
                return this.denied(res, 409, 'Request identifier is already active');
            if (this.admitted + ids.length > 128)
                return this.denied(res, 503, 'Too many active requests');
            const protocolVersion = req.headers['mcp-protocol-version'];
            if (protocolVersion !== undefined && (typeof protocolVersion !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)))
                return this.denied(res, 400, 'Unsupported protocol version');
            const json = this.options.enableJsonResponse && requests.length === 1 && ['ping', 'tools/list', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get'].includes(requests[0].method);
            res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', ...(json ? {} : { 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }) });
            if (!json)
                res.write(': open\n\n');
            const operations = [];
            let remaining = requests.length;
            const keepalive = json ? undefined : setInterval(() => { if (!res.destroyed && !res.writableEnded)
                res.write(': keepalive\n\n'); }, 15000);
            keepalive?.unref();
            res.once('close', () => { if (keepalive)
                clearInterval(keepalive); });
            res.once('finish', () => { if (keepalive)
                clearInterval(keepalive); });
            const write = (message) => { if (!res.destroyed && !res.writableEnded)
                res.write(json ? JSON.stringify(message) : `event: message\ndata: ${JSON.stringify(message)}\n\n`); };
            const complete = (op) => { if (op.completed)
                return; op.completed = true; for (const [id, input] of this.prompts)
                if (input.operation === op)
                    this.prompts.delete(id); if (--remaining === 0 && !res.destroyed && !res.writableEnded)
                res.end(); };
            const disconnected = () => { if (!res.writableFinished)
                for (const op of operations)
                    if (!op.completed)
                        op.operation.abort(); };
            res.once('close', disconnected);
            try {
                for (const request of requests) {
                    const releasePermit = this.reserveOperation();
                    if (!releasePermit)
                        throw new Error('Operation capacity exceeded');
                    let op;
                    let operation;
                    try {
                        operation = this.createOperation({ request, initialize: claims.params, createServer: this.factory, onEvent: event => {
                                if (event.type === 'clientInput') {
                                    if (json || this.prompts.size >= 128)
                                        throw new Error('Client input unavailable');
                                    this.prompts.set(event.id, { operation: op, nonce: claims.nonce });
                                    write(event.message);
                                }
                                else if (event.type === 'notification') {
                                    if (!json)
                                        write(event.message);
                                }
                                else {
                                    write(event.message);
                                    complete(op);
                                }
                            } });
                    }
                    catch (error) {
                        releasePermit();
                        throw error;
                    }
                    op = { operation, id: request.id, response: res, completed: false };
                    operations.push(op);
                    this.active.set(key(claims.nonce, request.id), op);
                    void operation.settled.then(() => { this.active.delete(key(claims.nonce, request.id)); releasePermit(); });
                }
                for (const op of operations) {
                    void op.operation.settled.then(() => { if (!op.completed) {
                        write({ jsonrpc: '2.0', id: op.id, error: { code: -32000, message: 'Request cancelled' } });
                        complete(op);
                    } });
                    void op.operation.start().catch(() => { if (!op.completed) {
                        write({ jsonrpc: '2.0', id: op.id, error: { code: -32603, message: 'Request initialization failed' } });
                        complete(op);
                    } });
                }
            }
            catch (error) {
                for (const op of operations) {
                    op.operation.abort();
                    void op.operation.start().catch(() => { });
                    complete(op);
                }
                if (!res.destroyed && !res.writableEnded)
                    res.end();
            }
        }
        catch (e) {
            if (!res.headersSent && !res.destroyed)
                this.denied(res, e.status ?? 500, 'HTTP request failed');
            else if (!res.writableEnded && !res.destroyed)
                res.end();
        }
    }
    close() {
        if (this.closePromise)
            return this.closePromise;
        this.closing = true;
        const operations = [...this.active.values()].map(op => op.operation);
        for (const operation of operations)
            operation.abort();
        const stopped = new Promise(resolve => this.httpServer.close(() => resolve()));
        this.httpServer.closeAllConnections();
        const drain = Promise.all([stopped, this.modern.close(), ...operations.map(operation => operation.settled)]).then(() => { });
        this.closePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('HTTP operations did not settle before shutdown; backend cleanup skipped and outcomes may be unknown.')), this.options.shutdownWaitMs ?? 4500);
            drain.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
        });
        return this.closePromise;
    }
}
