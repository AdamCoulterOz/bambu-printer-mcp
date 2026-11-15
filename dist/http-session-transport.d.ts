import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, type MessageExtraInfo, type RequestId } from "@modelcontextprotocol/sdk/types.js";
/** Keep wire IDs exact while giving SDK request/cancellation bookkeeping truthy, unique IDs. */
export declare class HttpSessionTransport implements Transport {
    private readonly transport;
    private readonly server;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    private readonly internal;
    private readonly wire;
    private closing?;
    constructor(transport: Transport, server: Server);
    get sessionId(): string | undefined;
    start(): Promise<void>;
    setProtocolVersion(version: string): void;
    close(): Promise<void>;
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
    finishCancelled(original: RequestId): Promise<void>;
    cancelDisconnected(original: RequestId): void;
}
