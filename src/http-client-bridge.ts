#!/usr/bin/env node
/** A protocol relay: it owns one HTTP session and never starts a printer server. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Configure the bridge using environment variables only');
  const url = parseUrl(process.env.BAMBU_MCP_HTTP_URL ?? 'http://127.0.0.1:3000/mcp');
  const tokenPath = process.env.BAMBU_MCP_HTTP_TOKEN_FILE;
  if (!tokenPath) throw new Error('BAMBU_MCP_HTTP_TOKEN_FILE is required');
  const token = await readToken(tokenPath);
  const pending = new Set<string>();
  let initializeId: string | undefined;
  let closing = false;
  let failed = false;
  const stdio = new StdioServerTransport();
  let http: StreamableHTTPClientTransport;

  async function shutdown(failure: boolean): Promise<void> {
    if (failure) failed = true;
    if (closing) return;
    closing = true;
    // DELETE has a bounded wait; aborting transport afterwards cancels only this session's requests.
    const deadline = setTimeout(() => { void http.close(); }, 2000);
    deadline.unref();
    try { await http.terminateSession(); } catch { if (!failure) failed = true; }
    clearTimeout(deadline);
    await http.close();
    await stdio.close();
    process.exitCode = failed ? 1 : 0;
  }
  function fail(): void {
    if (!closing) {
      process.stderr.write('HTTP bridge failed; request outcome may be unknown. Check server state before retrying.\n');
      void shutdown(true);
    }
  }
  const guardedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('HTTP redirect rejected');
    }
    const method = init?.method ?? 'GET';
    let requestId: string | undefined;
    if (method === 'POST' && typeof init?.body === 'string') {
      const message = JSON.parse(init.body) as JSONRPCMessage;
      if ('method' in message && 'id' in message && message.id !== undefined) requestId = idKey(message.id);
    }
    if (response.status === 202 && requestId) {
      await response.body?.cancel();
      throw new Error('HTTP request accepted without a response');
    }
    if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            setImmediate(() => { if (!closing && (method === 'GET' || (requestId && pending.has(requestId)))) fail(); });
          } else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      async cancel() { await reader.cancel(); }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: guardedFetch,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
  });
  // SDK 1.32.2 considers an SSE JSON-RPC error incomplete and invokes its
  // reconnection limiter even after delivering it. The guarded stream checks
  // actual outstanding request IDs on EOF, so that limiter is not evidence of
  // failure. All other transport errors remain fatal.
  http.onerror = error => {
    if (error.message !== 'Maximum reconnection attempts (0) exceeded.') fail();
  };
  stdio.onerror = fail;
  http.onmessage = message => {
    if (!('method' in message) && message.id !== undefined) {
      const key = idKey(message.id);
      pending.delete(key);
      if (key === initializeId && 'result' in message && typeof message.result.protocolVersion === 'string') {
        http.setProtocolVersion(message.result.protocolVersion);
      }
    }
    void stdio.send(message).catch(fail);
  };
  stdio.onmessage = message => {
    if (closing) return;
    if ('method' in message && 'id' in message && message.id !== undefined) {
      const key = idKey(message.id);
      pending.add(key);
      if (message.method === 'initialize') initializeId = key;
    } else if ('method' in message && message.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (typeof id === 'string' || typeof id === 'number') pending.delete(idKey(id));
    }
    void http.send(message).catch(fail);
  };
  process.stdin.once('end', () => { void shutdown(false); });
  process.stdout.once('error', fail);
  await http.start();
  await stdio.start();
}

main().catch(() => {
  process.stderr.write('HTTP bridge could not start: check URL and private token file.\n');
  process.exitCode = 1;
});
