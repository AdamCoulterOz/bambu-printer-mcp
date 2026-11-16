#!/usr/bin/env node
/** A protocol relay: it owns one HTTP session and never starts a printer server. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const MAX_TOKEN_BYTES = 4096;

async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        stat.size < 1 || stat.size > MAX_TOKEN_BYTES) throw new Error('invalid token file');
    const bytes = await file.readFile();
    if (bytes.length > MAX_TOKEN_BYTES) throw new Error('invalid token file');
    const token = bytes.toString('utf8').trim();
    if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error('invalid token file');
    return token;
  } finally { await file.close(); }
}

function parseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
       ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('URL must use HTTPS or loopback HTTP and contain no credentials, query or fragment');
  }
  return url;
}

function idKey(id: string | number): string { return `${typeof id}:${id}`; }

class BridgeError extends Error {}
const MAX_INIT_BYTES = 64 * 1024;
const DISCOVERY = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'ping']);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Configure the bridge using environment variables only');
  const url = parseUrl(process.env.BAMBU_MCP_HTTP_URL ?? 'http://127.0.0.1:3000/mcp');
  const tokenPath = process.env.BAMBU_MCP_HTTP_TOKEN_FILE;
  if (!tokenPath) throw new Error('BAMBU_MCP_HTTP_TOKEN_FILE is required');
  const token = await readToken(tokenPath);
  const pending = new Map<string, { id: string | number; method: string; expired: boolean }>();
  let initializeId: string | undefined;
  let initializeParams: unknown;
  let originalContract: string | undefined;
  let protocol: string | undefined;
  let ticket: string | undefined;
  let recovery: Promise<string> | undefined;
  let closing = false;
  let failed = false;
  const stdio = new StdioServerTransport();
  let http: StreamableHTTPClientTransport;

  function report(id: string | number, text: string): void {
    if (!pending.delete(idKey(id))) return;
    void stdio.send({jsonrpc: '2.0', id, error: {code: -32000, message: text}}).catch(() => { void shutdown(true); });
  }
  async function shutdown(failure: boolean, signal?: NodeJS.Signals): Promise<void> {
    if (failure) failed = true;
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => { void http.close(); }, 1800);
    deadline.unref();
    try { await http.terminateSession(); } catch { /* expired sessions and transport loss need no cleanup */ }
    clearTimeout(deadline);
    await http.close();
    await stdio.close();
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = failed ? 1 : 0;
  }
  function fail(): void {
    if (!closing) {
      process.stderr.write('HTTP bridge failed; request outcome may be unknown. Check server state before retrying.\n');
      void shutdown(true);
    }
  }
  function diagnostic(status: number, retryAfter: boolean): string {
    if (status === 401 || status === 403) return `HTTP authentication rejected (${status}); no retry attempted.`;
    if (status === 503) return `HTTP server capacity unavailable (503)${retryAfter ? '; retry-after indicated' : ''}; no automatic retry attempted.`;
    return `HTTP request failed (${status}); outcome may be unknown; no automatic retry attempted.`;
  }
  async function reinitialize(): Promise<string> {
    if (!initializeParams || !originalContract || !protocol) throw new Error('Cannot recover: original initialization is unavailable');
    const id = `bridge-init-${crypto.randomUUID()}`;
    const headers = new Headers({Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'});
    const response = await fetch(url, {method: 'POST', headers, body: JSON.stringify({jsonrpc: '2.0', id, method: 'initialize', params: initializeParams}), redirect: 'manual', signal: AbortSignal.timeout(10000)});
    if (!response.ok) { await response.body?.cancel(); throw new Error(diagnostic(response.status, response.headers.has('retry-after'))); }
    const newTicket = response.headers.get('mcp-session-id');
    if (!newTicket) { await response.body?.cancel(); throw new Error('Recovery initialization did not supply a session ticket'); }
    if (!response.body) throw new Error('Recovery initialization response missing');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_INIT_BYTES) { await reader.cancel(); throw new Error('Recovery initialization response exceeds limit'); } chunks.push(part.value); }
    const text = Buffer.concat(chunks).toString('utf8');
    let message: any;
    if (response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
      for (const item of data) { const candidate = JSON.parse(item); if (candidate.id === id) message = candidate; }
    } else message = JSON.parse(text);
    if (!message || message.id !== id || !message.result || typeof message.result.protocolVersion !== 'string' ||
        canonical({protocolVersion: message.result.protocolVersion, capabilities: message.result.capabilities, serverInfo: message.result.serverInfo, instructions: message.result.instructions}) !== originalContract) {
      throw new Error('Recovery refused because server protocol or capabilities changed');
    }
    const notification = await fetch(url, {method: 'POST', headers: new Headers({...Object.fromEntries(headers), 'mcp-session-id': newTicket, 'mcp-protocol-version': protocol}), body: JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}), redirect: 'manual', signal: AbortSignal.timeout(10000)});
    await notification.body?.cancel();
    if (!notification.ok) throw new Error(diagnostic(notification.status, notification.headers.has('retry-after')));
    ticket = newTicket;
    return newTicket;
  }
  const guardedFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    let message: any;
    if (method === 'POST' && typeof init?.body === 'string') message = JSON.parse(init.body);
    const key = message && typeof message.method === 'string' && 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number') ? idKey(message.id) : undefined;
    const send = (override?: string) => {
      const headers = new Headers(init?.headers);
      if (override) headers.set('mcp-session-id', override);
      return fetch(input, {...init, headers, redirect: 'manual'});
    };
    const sentTicket = ticket ?? new Headers(init?.headers).get('mcp-session-id') ?? undefined;
    let response = await send(ticket);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new BridgeError('HTTP redirect rejected'); }
    if (method === 'POST' && response.status === 404 && key && pending.has(key)) {
      pending.get(key)!.expired = true;
      await response.body?.cancel();
      if (!DISCOVERY.has(message.method)) throw new BridgeError('HTTP session expired; request was not replayed and outcome may be unknown.');
      // Let concurrent rejected requests register their 404 before deciding whether recovery is safe.
      await new Promise(resolve => setTimeout(resolve, 30));
      if ([...pending.values()].some(p => !p.expired)) throw new BridgeError('Session expired while another request was in flight; outcome may be unknown.');
      if (!recovery && (!ticket || ticket === sentTicket)) recovery = reinitialize().catch(() => { throw new BridgeError('Session recovery failed or server contract changed.'); }).finally(() => { recovery = undefined; });
      const nextTicket = recovery ? await recovery : ticket!;
      response = await send(nextTicket);
    }
    if (!response.ok && !(method === 'GET' && response.status === 405) && !(method === 'DELETE' && response.status === 405)) {
      const status = response.status, retryAfter = response.headers.has('retry-after');
      await response.body?.cancel();
      throw new BridgeError(diagnostic(status, retryAfter));
    }
    if (response.status === 202 && key) { await response.body?.cancel(); throw new BridgeError('HTTP request accepted without a response; outcome may be unknown.'); }
    if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            if (key) setImmediate(() => { if (!closing && pending.has(key)) report(message.id, 'HTTP response stream ended before completion; outcome may be unknown.'); });
            else if (method === 'GET' && !closing) process.stderr.write('HTTP server event stream ended; server-initiated events may be unavailable.\n');
          } else controller.enqueue(next.value);
        } catch { controller.error(new Error('HTTP response stream lost')); if (key && !closing) report(message.id, 'HTTP response stream lost; outcome may be unknown.'); }
      },
      async cancel() { await reader.cancel(); }
    });
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
  http = new StreamableHTTPClientTransport(url, {
    requestInit: {headers: {Authorization: `Bearer ${token}`}}, fetch: guardedFetch,
    reconnectionOptions: {maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1}
  });
  // Request failures are reported by the individual send or stream; the SDK also emits them here.
  http.onerror = error => {
    if (!closing && error.message !== 'Maximum reconnection attempts (0) exceeded.')
      process.stderr.write('HTTP bridge transport reported an error.\n');
  };
  stdio.onerror = fail;
  http.onmessage = message => {
    if (!('method' in message) && message.id !== undefined) {
      const key = idKey(message.id);
      pending.delete(key);
      if (key === initializeId && 'result' in message && typeof message.result.protocolVersion === 'string') {
        protocol = message.result.protocolVersion;
        originalContract = canonical({protocolVersion: protocol, capabilities: message.result.capabilities, serverInfo: message.result.serverInfo, instructions: message.result.instructions});
        http.setProtocolVersion(protocol);
      }
    }
    void stdio.send(message).catch(fail);
  };
  stdio.onmessage = message => {
    if (closing) return;
    // This relay exposes the 2025-era stdio protocol. A modern auto-negotiating
    // host probes a disposable child first; reject locally so it can select
    // legacy initialization without sending a modern request over legacy HTTP.
    if ('method' in message && message.method === 'server/discover' && 'id' in message && message.id !== undefined) {
      void stdio.send({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Method not found'}}).catch(fail);
      return;
    }
    if ('method' in message && 'id' in message && message.id !== undefined) {
      const key = idKey(message.id);
      pending.set(key, {id: message.id, method: message.method, expired: false});
      if (message.method === 'initialize') {
        initializeId = key;
        const encoded = JSON.stringify(message.params);
        if (!encoded || Buffer.byteLength(encoded) > MAX_INIT_BYTES || !InitializeRequestSchema.safeParse(message).success || initializeParams !== undefined) {
          report(message.id, 'Invalid or oversized initialization parameters.'); return;
        }
        initializeParams = JSON.parse(encoded);
      }
    } else if ('method' in message && message.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (typeof id === 'string' || typeof id === 'number') pending.delete(idKey(id));
    }
    void http.send(message).catch(error => {
      if ('method' in message && 'id' in message && message.id !== undefined) report(message.id, error instanceof BridgeError ? error.message : 'HTTP transport failed; outcome may be unknown.');
      else if (!closing) process.stderr.write('HTTP bridge notification failed.\n');
    });
  };
  process.stdin.once('end', () => { void shutdown(false); });
  process.once('SIGTERM', () => { void shutdown(false, 'SIGTERM'); });
  process.once('SIGINT', () => { void shutdown(false, 'SIGINT'); });
  process.stdout.once('error', fail);
  await http.start();
  await stdio.start();
}

main().catch(() => {
  process.stderr.write('HTTP bridge could not start: check URL and private token file.\n');
  process.exitCode = 1;
});
