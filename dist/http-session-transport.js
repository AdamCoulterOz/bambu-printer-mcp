import { randomUUID } from "node:crypto";
import { isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse, CancelledNotificationSchema, isJSONRPCNotification } from "@modelcontextprotocol/sdk/types.js";
import { aliasRequest, forgetRequest } from "./request-context.js";
/** Keep wire IDs exact while giving SDK request/cancellation bookkeeping truthy, unique IDs. */
export class HttpSessionTransport {
    constructor(transport, server) {
        this.transport = transport;
        this.server = server;
        this.internal = new Map();
        this.wire = new Map();
        transport.onmessage = (message, extra) => {
            if (isJSONRPCRequest(message)) {
                const id = `client-${randomUUID()}`;
                this.internal.set(message.id, id);
                this.wire.set(id, message.id);
                aliasRequest(server, message.id, id);
                this.onmessage?.({ ...message, id }, extra);
            }
            else {
                if (isJSONRPCNotification(message)) {
                    const cancellation = CancelledNotificationSchema.safeParse(message);
                    const original = cancellation.success ? cancellation.data.params.requestId : undefined;
                    const id = original === undefined ? undefined : this.internal.get(original);
                    if (id !== undefined) {
                        this.onmessage?.({ ...message, params: { ...message.params, requestId: id } }, extra);
                        return;
                    }
                }
                // Client responses to server-initiated requests retain their IDs and direction.
                this.onmessage?.(message, extra);
            }
        };
        transport.onerror = error => this.onerror?.(error);
        transport.onclose = () => {
            this.onclose?.();
            for (const id of this.wire.keys())
                forgetRequest(server, id);
            this.internal.clear();
            this.wire.clear();
        };
    }
    get sessionId() { return this.transport.sessionId; }
    start() { return this.transport.start(); }
    setProtocolVersion(version) { this.transport.setProtocolVersion?.(version); }
    close() { return this.closing ?? (this.closing = this.transport.close()); }
    async send(message, options) {
        const terminal = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message);
        const internalId = terminal && typeof message.id === "string" && this.wire.has(message.id) ? message.id : undefined;
        const original = internalId === undefined ? undefined : this.wire.get(internalId);
        const related = options?.relatedRequestId;
        const translatedOptions = related !== undefined && typeof related === "string" && this.wire.has(related)
            ? { ...options, relatedRequestId: this.wire.get(related) } : options;
        try {
            await this.transport.send(internalId === undefined ? message : { ...message, id: original }, translatedOptions);
        }
        finally {
            if (internalId !== undefined) {
                this.wire.delete(internalId);
                if (this.internal.get(original) === internalId)
                    this.internal.delete(original);
                forgetRequest(this.server, internalId);
            }
        }
    }
    async finishCancelled(original) {
        const id = this.internal.get(original);
        if (id !== undefined)
            await this.send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Request cancelled" } });
    }
    cancelDisconnected(original) {
        const id = this.internal.get(original);
        if (id === undefined)
            return;
        this.onmessage?.({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
        queueMicrotask(() => { void this.finishCancelled(original).catch(() => { }); });
    }
}
