import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Server, ProtocolError, createMcpHandler, createRequestStateCodec, inputRequired, inputResponse, acceptedContent, fromJsonSchema } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { ActiveOperation } from './http-operation.js';
const METHODS = ['tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get'];
const MAX_ROUNDS = 32;
const stable = (x) => {
    if (Array.isArray(x))
        return `[${x.map(stable).join(',')}]`;
    if (x && typeof x === 'object')
        return `{${Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
    return JSON.stringify(x) ?? 'null';
};
const digest = (x) => createHash('sha256').update(stable(x)).digest('hex');
const principal = (ctx) => ctx.http?.authInfo?.clientId ?? 'anonymous';
const fail = (message) => { throw new ProtocolError(-32602, message); };
/** Modern per-request frontend. The only retained state belongs to active operations. */
export function createModernHttpAdapter(options) {
    const active = new Map();
    const maxActive = options.maxActive ?? 128;
    const pendingTimeoutMs = options.pendingTimeoutMs ?? 600000;
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || !Number.isSafeInteger(pendingTimeoutMs) || pendingTimeoutMs < 1 || pendingTimeoutMs > 600000)
        throw new Error('Invalid modern adapter limits');
    const codec = createRequestStateCodec({ key: randomBytes(32), ttlSeconds: Math.max(1, Math.ceil(pendingTimeoutMs / 1000)), bind: ctx => `${principal(ctx)}\0${ctx.mcpReq.method}` });
    const detach = (entry) => { if (entry.signal && entry.abortListener)
        entry.signal.removeEventListener('abort', entry.abortListener); entry.signal = undefined; entry.abortListener = undefined; entry.detached = true; };
    const attach = (entry, signal) => { detach(entry); entry.detached = false; entry.signal = signal; entry.abortListener = () => entry.operation.abort(new Error('Request cancelled')); signal.addEventListener('abort', entry.abortListener, { once: true }); if (signal.aborted)
        entry.abortListener(); };
    const identity = (ctx, params) => {
        const envelope = (ctx.mcpReq.envelope ?? {});
        const caps = envelope['io.modelcontextprotocol/clientCapabilities'];
        const info = envelope['io.modelcontextprotocol/clientInfo'];
        if (Buffer.byteLength(JSON.stringify({ caps, info })) > 16384)
            fail('Client metadata too large');
        return { caps, info, fingerprint: digest({ method: ctx.mcpReq.method, params, caps, info, principal: principal(ctx) }) };
    };
    const factory = () => {
        const server = new Server(options.serverInfo ?? { name: 'bambu-printer-mcp', version: '1.1.94' }, { instructions: options.instructions, capabilities: { tools: {}, resources: {}, prompts: {} }, requestState: { verify: codec.verify } });
        for (const method of METHODS)
            server.setRequestHandler(method, async (requestParams, ctx) => {
                const params = requestParams.params ?? {};
                const { caps, info, fingerprint } = identity(ctx, params);
                const state = ctx.mcpReq.requestState();
                let id;
                let entry;
                if (state !== undefined) {
                    if (!state || typeof state.id !== 'string' || typeof state.round !== 'string')
                        fail('Invalid continuation');
                    id = state.id;
                    const found = active.get(id);
                    if (!found || !found.round || found.round.id !== state.round || found.fingerprint !== fingerprint)
                        throw new ProtocolError(-32602, 'Unknown or expired continuation');
                    entry = found;
                    const round = found.round;
                    const values = round.inputs.map(input => {
                        const result = inputResponse(ctx.mcpReq.inputResponses, input.id);
                        if (result.kind !== 'elicit')
                            throw new ProtocolError(-32602, 'Missing or invalid elicitation response');
                        if (result.action === 'accept') {
                            const schema = input.message.params?.requestedSchema;
                            // Do not use fromJsonSchema's process-global validator: its AJV cache
                            // retains schema objects from otherwise completed operations.
                            const content = acceptedContent(ctx.mcpReq.inputResponses, input.id, fromJsonSchema(schema, new AjvJsonSchemaValidator()));
                            if (!content)
                                fail('Invalid elicitation content');
                            return { action: 'accept', content };
                        }
                        return { action: result.action };
                    });
                    entry.round = undefined;
                    if (entry.timer) {
                        clearTimeout(entry.timer);
                        entry.timer = undefined;
                    }
                    attach(entry, ctx.mcpReq.signal);
                    for (let i = 0; i < round.inputs.length; i++)
                        if (!entry.operation.respond(round.inputs[i].id, { jsonrpc: '2.0', id: round.inputs[i].id, result: values[i] })) {
                            entry.operation.abort();
                            fail('Continuation unavailable');
                        }
                }
                else {
                    if (ctx.mcpReq.inputResponses !== undefined)
                        fail('Continuation required');
                    if (active.size >= maxActive)
                        throw new ProtocolError(-32603, 'Too many active requests');
                    const release = options.reserveOperation?.();
                    if (options.reserveOperation && !release)
                        throw new ProtocolError(-32603, 'Too many active requests');
                    id = randomUUID();
                    // The modern envelope permits these fields to be absent; the legacy virtual
                    // initialize requires them. Never add capabilities the client did not send.
                    const init = { protocolVersion: '2025-11-25', capabilities: caps === undefined ? {} : caps, clientInfo: info === undefined ? { name: 'anonymous-mcp-client', version: 'unknown' } : info };
                    const request = { jsonrpc: '2.0', id: ctx.mcpReq.id, method, params: { ...params, ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}) } };
                    let current;
                    let operation;
                    try {
                        operation = (options.createOperation ?? (value => new ActiveOperation(value)))({ request, initialize: init, createServer: options.createProtocolServer, onEvent: event => { current.queue.push(event); current.wake?.(); } });
                    }
                    catch (error) {
                        release?.();
                        throw error;
                    }
                    entry = current = { operation, fingerprint, queue: [], rounds: 0, detached: false };
                    active.set(id, entry);
                    attach(entry, ctx.mcpReq.signal);
                    void operation.settled.then(() => { detach(entry); if (entry.timer)
                        clearTimeout(entry.timer); active.delete(id); release?.(); if (!entry.queue.some(event => event.type === 'terminal'))
                        entry.queue.push({ type: 'terminal', message: { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Operation stopped' } } }); entry.wake?.(); });
                    void operation.start().catch(() => { entry.queue.push({ type: 'terminal', message: { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Operation initialization failed' } } }); entry.wake?.(); });
                }
                try {
                    for (;;) {
                        while (!entry.queue.length)
                            await new Promise(resolve => { entry.wake = resolve; });
                        entry.wake = undefined;
                        const event = entry.queue.shift();
                        if (event.type === 'notification') {
                            await ctx.mcpReq.notify(event.message);
                            continue;
                        }
                        if (event.type === 'terminal') {
                            detach(entry);
                            if ('error' in event.message)
                                throw new ProtocolError(event.message.error.code, event.message.error.message, event.message.error.data);
                            return event.message.result;
                        }
                        const inputs = [event];
                        while (entry.queue[0]?.type === 'clientInput')
                            inputs.push(entry.queue.shift());
                        if (++entry.rounds > MAX_ROUNDS || inputs.length > 8) {
                            entry.operation.abort();
                            throw new ProtocolError(-32603, 'Too many input requests');
                        }
                        const inputRequests = {};
                        for (const input of inputs) {
                            if (input.message.method !== 'elicitation/create' || input.message.params?.mode === 'url') {
                                entry.operation.abort();
                                throw new ProtocolError(-32603, 'Unsupported client input');
                            }
                            inputRequests[input.id] = inputRequired.elicit(input.message.params);
                        }
                        const round = randomUUID();
                        const requestState = await codec.mint({ id, round }, ctx);
                        ctx.mcpReq.signal.throwIfAborted();
                        entry.round = { id: round, inputs };
                        // The SDK aborts the HTTP request signal even after a successful response.
                        detach(entry);
                        entry.timer = setTimeout(() => { entry.round = undefined; entry.operation.abort(new Error('Confirmation expired')); }, pendingTimeoutMs);
                        entry.timer.unref();
                        return inputRequired({ inputRequests, requestState });
                    }
                }
                catch (error) {
                    detach(entry);
                    if (!entry.round)
                        entry.operation.abort();
                    throw error;
                }
            });
        return server;
    };
    const handler = createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto' });
    return {
        fetch: (request, opts) => handler.fetch(request, opts),
        stats: () => ({ activeOperations: active.size, pendingContinuations: [...active.values()].filter(entry => !!entry.round).length }),
        close: async () => { for (const entry of active.values()) {
            if (entry.timer)
                clearTimeout(entry.timer);
            entry.operation.abort();
        } await handler.close(); await Promise.all([...active.values()].map(entry => entry.operation.settled)); },
    };
}
