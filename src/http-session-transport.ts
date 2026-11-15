import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse, CancelledNotificationSchema, isJSONRPCNotification, type JSONRPCMessage, type MessageExtraInfo, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { aliasRequest, forgetRequest } from "./request-context.js";

/** Keep wire IDs exact while giving SDK request/cancellation bookkeeping truthy, unique IDs. */
export class HttpSessionTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  private readonly internal = new Map<RequestId, string>();
  private readonly wire = new Map<string, RequestId>();
  private closing?: Promise<void>;
  constructor(private readonly transport: Transport, private readonly server: Server) {
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) {
        const id = `client-${randomUUID()}`;
        this.internal.set(message.id, id); this.wire.set(id, message.id);
        aliasRequest(server, message.id, id);
        this.onmessage?.({...message, id}, extra);
      } else {
        if (isJSONRPCNotification(message)) {
          const cancellation = CancelledNotificationSchema.safeParse(message);
          const original = cancellation.success ? cancellation.data.params.requestId : undefined;
          const id = original === undefined ? undefined : this.internal.get(original);
          if (id !== undefined) { this.onmessage?.({...message, params: {...message.params, requestId: id}}, extra); return; }
        }
        // Client responses to server-initiated requests retain their IDs and direction.
        this.onmessage?.(message, extra);
      }
    };
    transport.onerror = error => this.onerror?.(error);
    transport.onclose = () => {
      this.onclose?.();
      for (const id of this.wire.keys()) forgetRequest(server, id);
      this.internal.clear(); this.wire.clear();
    };
  }
  get sessionId(): string | undefined { return this.transport.sessionId; }
  start(): Promise<void> { return this.transport.start(); }
  setProtocolVersion(version: string): void { this.transport.setProtocolVersion?.(version); }
  close(): Promise<void> { return this.closing ??= this.transport.close(); }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const terminal = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
    const internalId = terminal && typeof message.id === "string" && this.wire.has(message.id) ? message.id : undefined;
    const original = internalId === undefined ? undefined : this.wire.get(internalId);
    const related = options?.relatedRequestId;
    const translatedOptions = related !== undefined && typeof related === "string" && this.wire.has(related)
      ? {...options, relatedRequestId: this.wire.get(related)} : options;
    try {
      await this.transport.send(internalId === undefined ? message : {...message, id: original!}, translatedOptions);
    } finally {
      if (internalId !== undefined) {
        this.wire.delete(internalId);
        if (this.internal.get(original!) === internalId) this.internal.delete(original!);
        forgetRequest(this.server, internalId);
      }
    }
  }
  async finishCancelled(original: RequestId): Promise<void> {
    const id = this.internal.get(original);
    if (id !== undefined) await this.send({jsonrpc: "2.0", id, error: {code: -32000, message: "Request cancelled"}});
  }
  cancelDisconnected(original: RequestId): void {
    const id = this.internal.get(original);
    if (id === undefined) return;
    this.onmessage?.({jsonrpc: "2.0", method: "notifications/cancelled", params: {requestId: id}});
    queueMicrotask(() => { void this.finishCancelled(original).catch(() => {}); });
  }
}
