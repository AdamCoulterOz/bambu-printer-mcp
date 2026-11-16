import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCRequest, isJSONRPCNotification, isJSONRPCResultResponse, isJSONRPCErrorResponse, type InitializeRequest, type JSONRPCMessage, type JSONRPCRequest, type JSONRPCNotification, type JSONRPCResultResponse, type JSONRPCErrorResponse, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import { trackRequest, cancelTrackedRequest, cancelSessionRequests } from './request-context.js';

export type OperationEvent =
  | { type: 'terminal'; message: JSONRPCResultResponse | JSONRPCErrorResponse }
  | { type: 'clientInput'; id: string; message: JSONRPCRequest }
  | { type: 'notification'; message: JSONRPCNotification };
export type ActiveOperationOptions = {
  request: JSONRPCRequest;
  initialize: InitializeRequest['params'];
  createServer: () => Server;
  onEvent: (event: OperationEvent) => void;
  deadlineMs?: number;
  abortGraceMs?: number;
  onUnsettled?: () => void;
};

/** Owns one actual RPC and its server, with no HTTP or client-session lifetime. */
export class ActiveOperation {
  private transportClosed = false;
  private readonly transport: Transport = {
    start: async () => {},
    close: async () => {
      if (this.transportClosed) return;
      this.transportClosed = true;
      this.transport.onclose?.();
    },
    send: (message, options) => this.send(message, options),
  };
  readonly settled: Promise<void>;
  private readonly server: Server;
  private readonly internalId = `request-${randomUUID()}`;
  private readonly initializeId = `initialize-${randomUUID()}`;
  private readonly inputs = new Map<string,RequestId>();
  private resolveSettled!: () => void;
  private initializeResult?: {resolve: () => void; reject: (error: Error) => void};
  private terminal = false;
  private started = false;
  private aborted = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private abortWatchdog?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: ActiveOperationOptions) {
    if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 1_800_000)) throw new Error('Invalid operation deadline');
    if (options.abortGraceMs !== undefined && (!Number.isSafeInteger(options.abortGraceMs) || options.abortGraceMs < 1 || options.abortGraceMs > 60_000)) throw new Error('Invalid operation abort grace');
    this.server = options.createServer();
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
    trackRequest(this.server,this.internalId);
  }
  async start(): Promise<void> {
    if (this.started) throw new Error('Operation already started');
    this.started = true;
    this.deadline=setTimeout(() => this.abort(new Error('Operation deadline exceeded')),this.options.deadlineMs ?? 1_800_000); this.deadline.unref();
    try {
      await this.server.connect(this.transport);
      await new Promise<void>((resolve,reject) => {
        this.initializeResult={resolve,reject};
        this.transport.onmessage?.({jsonrpc:'2.0',id:this.initializeId,method:'initialize',params:this.options.initialize});
      });
      if (this.aborted) { this.finish(); return; }
      this.transport.onmessage?.({...this.options.request,id:this.internalId});
    } catch (error) { this.finish(); throw error; }
  }
  private async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id===this.initializeId) {
      const result=this.initializeResult; this.initializeResult=undefined;
      if (isJSONRPCErrorResponse(message)) result?.reject(new Error('Virtual initialization failed')); else result?.resolve();
      return;
    }
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id===this.internalId) {
      try { this.options.onEvent({type:'terminal',message:{...message,id:this.options.request.id}}); } finally { this.finish(); }
      return;
    }
    if (isJSONRPCRequest(message)) {
      if (options?.relatedRequestId!==this.internalId) throw new Error('Server request requires an owning operation');
      if (this.inputs.size>=8) throw new Error('Too many pending client inputs');
      const id=`input-${randomUUID()}`; this.inputs.set(id,message.id);
      this.options.onEvent({type:'clientInput',id,message:{...message,id}}); return;
    }
    if (isJSONRPCNotification(message)) {
      if (options?.relatedRequestId!==this.internalId) throw new Error('Server notification requires an owning operation');
      let outgoing=message;
      if (message.method==='notifications/cancelled' && message.params?.requestId !== undefined) {
        for (const [id,internal] of this.inputs) if (internal===message.params.requestId) { this.inputs.delete(id); outgoing={...message,params:{...message.params,requestId:id}}; break; }
      }
      this.options.onEvent({type:'notification',message:outgoing});
    }
  }
  respond(id: string, response: JSONRPCResultResponse | JSONRPCErrorResponse): boolean {
    const internal=this.inputs.get(id); if (internal===undefined || this.terminal || this.aborted) return false;
    this.inputs.delete(id); this.transport.onmessage?.({...response,id:internal}); return true;
  }
  abort(_reason?: Error): void {
    if (this.terminal || this.aborted) return; this.aborted=true; cancelTrackedRequest(this.server,this.internalId);
    if (this.options.onUnsettled) this.abortWatchdog=setTimeout(() => this.options.onUnsettled?.(),this.options.abortGraceMs ?? 30_000);
  }
  private finish(): void {
    if (this.terminal) return; this.terminal=true; if (this.deadline) clearTimeout(this.deadline); if (this.abortWatchdog) clearTimeout(this.abortWatchdog); this.inputs.clear(); cancelSessionRequests(this.server);
    void this.server.close().finally(() => this.resolveSettled());
  }
}
