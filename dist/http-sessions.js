import { HttpSessionTransport } from "./http-session-transport.js";
import { trackRequest, cancelTrackedRequest, forgetRequest, cancelSessionRequests } from "./request-context.js";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CancelledNotificationSchema, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
/** Read once at startup. The file and its contents are never exposed through diagnostics. */
export function httpBearerToken(env = process.env) {
    if (env.MCP_HTTP_BEARER_TOKEN !== undefined && env.MCP_HTTP_BEARER_TOKEN_FILE !== undefined) {
        throw new Error("Configure only one HTTP bearer token source.");
    }
    let token = env.MCP_HTTP_BEARER_TOKEN;
    if (env.MCP_HTTP_BEARER_TOKEN_FILE !== undefined) {
        const file = env.MCP_HTTP_BEARER_TOKEN_FILE;
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
            throw new Error("HTTP bearer token file must be a private, owner-only regular file (maximum 4096 bytes).");
        }
        token = readFileSync(file, "utf8").trim();
    }
    if (token !== undefined && (!token || token.length > 4096 || /\s/.test(token))) {
        throw new Error("HTTP bearer token must be a nonempty token without whitespace (maximum 4096 characters).");
    }
    return token;
}
function reject(res, status, message) {
    res.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(message);
}
function authorized(actual, token) {
    const expected = Buffer.from(`Bearer ${token}`);
    const provided = Buffer.from(actual ?? "");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function body(req, maximum) {
    if (Number(req.headers["content-length"]) > maximum)
        throw Object.assign(new Error("Request too large"), { status: 413 });
    const chunks = [];
    let bytes = 0;
    const buffer = await new Promise((resolve, reject) => {
        const cleanup = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); };
        const error = (failure) => { cleanup(); reject(failure); };
        const aborted = () => error(new Error("Request aborted"));
        const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
        const data = (chunk) => {
            bytes += chunk.length;
            if (bytes > maximum) {
                cleanup();
                chunks.length = 0;
                req.resume();
                reject(Object.assign(new Error("Request too large"), { status: 413 }));
            }
            else
                chunks.push(chunk);
        };
        req.on("data", data);
        req.once("end", end);
        req.once("error", error);
        req.once("aborted", aborted);
    });
    try {
        return JSON.parse(buffer.toString("utf8"));
    }
    catch {
        throw Object.assign(new Error("Invalid JSON"), { status: 400 });
    }
}
function cancellationId(message) {
    if (!isJSONRPCNotification(message))
        return undefined;
    const parsed = CancelledNotificationSchema.safeParse(message);
    return parsed.success ? parsed.data.params.requestId : undefined;
}
function controlOnly(body) {
    const messages = Array.isArray(body) ? body : [body];
    return messages.length > 0 && messages.every(message => cancellationId(message) !== undefined || isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message));
}
/** Owns protocol sessions only. Shared printer/account/bridge cleanup belongs to the process owner. */
export class HttpSessions {
    constructor(options, createProtocolServer) {
        this.options = options;
        this.createProtocolServer = createProtocolServer;
        this.sessions = new Map();
        this.pending = new Set();
        this.activeRequests = 0;
        this.controlRequests = 0;
        const loopback = ["127.0.0.1", "localhost", "::1"].includes(options.host);
        if (!loopback && !options.bearerToken)
            throw new Error("Non-loopback HTTP requires an explicit bearer token.");
        if (!loopback && !isIP(options.host) && !options.allowedHosts?.size)
            throw new Error("Non-loopback HTTP hostname binding requires MCP_HTTP_ALLOWED_HOSTS.");
        if (["0.0.0.0", "::"].includes(options.host) && !options.allowedHosts?.size)
            throw new Error("Wildcard HTTP binding requires MCP_HTTP_ALLOWED_HOSTS.");
        this.httpServer = createServer((req, res) => { void this.handle(req, res); });
        this.httpServer.requestTimeout = 30000;
        this.httpServer.headersTimeout = 15000;
        this.expiry = setInterval(() => { void this.expire(); }, Math.min(options.idleTimeoutMs ?? 1800000, 60000));
        this.expiry.unref();
    }
    async listen() {
        await new Promise((resolve, reject) => {
            this.httpServer.once("error", reject);
            this.httpServer.listen(this.options.port, this.options.host, () => { this.httpServer.off("error", reject); resolve(); });
        });
    }
    validHost(host) {
        if (!host)
            return false;
        if (this.options.allowedHosts?.size)
            return this.options.allowedHosts.has(host);
        const address = this.httpServer.address();
        const port = address && typeof address !== "string" ? address.port : this.options.port;
        const names = ["127.0.0.1", "localhost", "::1"].includes(this.options.host)
            ? ["127.0.0.1", "localhost", "[::1]"] : [isIP(this.options.host) === 6 ? `[${this.options.host}]` : this.options.host];
        return names.some(name => host === `${name}:${port}` || (port === 80 && host === name));
    }
    async handle(req, res) {
        try {
            if (this.closing)
                return reject(res, 503, "Server shutting down");
            if (!this.validHost(req.headers.host))
                return reject(res, 403, "Forbidden host");
            const origin = req.headers.origin;
            if (origin !== undefined && !this.options.allowedOrigins.has(origin))
                return reject(res, 403, "Forbidden origin");
            if (new URL(req.url ?? "/", "http://localhost").pathname !== this.options.path)
                return reject(res, 404, "Not found");
            if (req.method === "OPTIONS") {
                if (origin) {
                    res.setHeader("Access-Control-Allow-Origin", origin);
                    res.setHeader("Vary", "Origin");
                }
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
                res.writeHead(204);
                res.end();
                return;
            }
            if (this.options.bearerToken && !authorized(req.headers.authorization, this.options.bearerToken)) {
                res.setHeader("WWW-Authenticate", "Bearer");
                return reject(res, 401, "Unauthorized");
            }
            if (!["POST", "GET", "DELETE"].includes(req.method ?? ""))
                return reject(res, 405, "Method not allowed");
            // Reserve bounded capacity for cancellation/elicitation replies; DELETE always remains available.
            const reservedControl = this.activeRequests >= 128 && req.method === "POST";
            if (this.activeRequests >= 128 && req.method !== "DELETE" && (!reservedControl || this.controlRequests >= 8))
                return reject(res, 503, "Too many active requests");
            if (reservedControl)
                this.controlRequests++;
            this.activeRequests++;
            let released = false;
            const release = () => { if (!released) {
                released = true;
                this.activeRequests--;
                if (reservedControl)
                    this.controlRequests--;
            } };
            res.once("close", release);
            res.once("finish", release);
            if (origin) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Vary", "Origin");
            }
            res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
            const rawId = req.headers["mcp-session-id"];
            if (Array.isArray(rawId))
                return reject(res, 400, "Invalid session identifier");
            let session = rawId ? this.sessions.get(rawId) : undefined;
            if (rawId && !session)
                return reject(res, 404, "Unknown session");
            let parsed;
            if (req.method === "POST")
                parsed = await body(req, this.options.maxBodyBytes ?? 4 * 1024 * 1024);
            if (reservedControl && !controlOnly(parsed))
                return reject(res, 503, "Too many active requests");
            if (this.closing)
                return reject(res, 503, "Server shutting down");
            if (!session) {
                if (req.method !== "POST" || !isInitializeRequest(parsed))
                    return reject(res, 400, "Initialize a session first");
                if (this.sessions.size + this.pending.size >= (this.options.maxSessions ?? 32))
                    return reject(res, 503, "Session limit reached");
                const server = this.createProtocolServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(), enableJsonResponse: this.options.enableJsonResponse,
                    onsessioninitialized: id => { this.pending.delete(created); this.sessions.set(id, created); },
                });
                const protocol = new HttpSessionTransport(transport, server);
                const created = { server, transport, protocol, touched: Date.now(), active: 0, requests: new Map(), delivered: new Set() };
                session = created;
                this.pending.add(created);
                server.onclose = () => { cancelSessionRequests(server); this.pending.delete(created); if (transport.sessionId)
                    this.sessions.delete(transport.sessionId); };
                try {
                    await server.connect(protocol);
                    const onmessage = transport.onmessage;
                    transport.onmessage = (message, extra) => {
                        if (isJSONRPCRequest(message))
                            created.delivered.add(message.id);
                        const requestId = cancellationId(message);
                        if (requestId !== undefined && created.delivered.has(requestId))
                            cancelTrackedRequest(server, requestId);
                        onmessage?.(message, extra);
                        if (requestId === undefined || !created.requests.has(requestId) || !created.delivered.has(requestId))
                            return;
                        // The SDK suppresses replies after abort, leaving the original POST open.
                        // Its cancellation handler runs in the preceding microtask. Send the terminal
                        // error through the same transport so JSON and SSE/batch cleanup stay SDK-owned.
                        queueMicrotask(() => {
                            if (created.requests.has(requestId))
                                void protocol.finishCancelled(requestId).catch(() => {
                                    // A concurrently closed transport may no longer own its response route.
                                    // Dispose only this request's response so cancellation cannot consume a slot.
                                    created.requests.get(requestId)?.destroy();
                                });
                        });
                    };
                }
                catch (error) {
                    this.pending.delete(created);
                    await server.close();
                    throw error;
                }
            }
            const current = session;
            const messages = Array.isArray(parsed) ? parsed : [parsed];
            const requestIds = messages.filter(isJSONRPCRequest).map(message => message.id);
            if (new Set(requestIds).size !== requestIds.length || requestIds.some(id => current.requests.has(id)))
                return reject(res, 409, "Request identifier is already active");
            for (const id of requestIds) {
                current.requests.set(id, res);
                trackRequest(current.server, id);
            }
            current.active++;
            current.touched = Date.now();
            let settled = false;
            const finished = () => {
                if (settled)
                    return;
                settled = true;
                current.active--;
                current.touched = Date.now();
                for (const id of requestIds)
                    if (current.requests.get(id) === res) {
                        if (!res.writableFinished) {
                            cancelTrackedRequest(current.server, id);
                            current.protocol.cancelDisconnected(id);
                        }
                        current.requests.delete(id);
                        current.delivered.delete(id);
                        forgetRequest(current.server, id);
                    }
            };
            res.once("finish", finished);
            res.once("close", finished);
            try {
                await current.transport.handleRequest(req, res, parsed);
            }
            finally {
                // A rejected initialize has no retained session and owns no backend cleanup.
                if (!current.transport.sessionId) {
                    this.pending.delete(current);
                    await current.server.close();
                }
            }
        }
        catch (error) {
            if (!res.headersSent && !res.destroyed)
                reject(res, error.status ?? 500, "HTTP request failed");
            else if (!res.writableEnded)
                res.end();
        }
    }
    async expire() {
        const threshold = Date.now() - (this.options.idleTimeoutMs ?? 1800000);
        await Promise.allSettled([...this.sessions.values()].filter(session => !session.active && session.touched < threshold).map(session => session.server.close()));
    }
    close() {
        if (this.closing)
            return this.closing;
        clearInterval(this.expiry);
        this.closing = (async () => {
            const stopped = new Promise(resolve => this.httpServer.close(() => resolve()));
            await Promise.allSettled([...this.sessions.values(), ...this.pending].map(session => session.server.close()));
            this.sessions.clear();
            this.pending.clear();
            this.httpServer.closeAllConnections();
            await stopped;
        })();
        return this.closing;
    }
}
