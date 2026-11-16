import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type InitializeRequest, type JSONRPCRequest, type JSONRPCNotification, type JSONRPCResultResponse, type JSONRPCErrorResponse } from '@modelcontextprotocol/sdk/types.js';
export type OperationEvent = {
    type: 'terminal';
    message: JSONRPCResultResponse | JSONRPCErrorResponse;
} | {
    type: 'clientInput';
    id: string;
    message: JSONRPCRequest;
} | {
    type: 'notification';
    message: JSONRPCNotification;
};
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
export declare class ActiveOperation {
    private readonly options;
    private transportClosed;
    private readonly transport;
    readonly settled: Promise<void>;
    private readonly server;
    private readonly internalId;
    private readonly initializeId;
    private readonly inputs;
    private resolveSettled;
    private initializeResult?;
    private terminal;
    private started;
    private aborted;
    private deadline?;
    private abortWatchdog?;
    constructor(options: ActiveOperationOptions);
    start(): Promise<void>;
    private send;
    respond(id: string, response: JSONRPCResultResponse | JSONRPCErrorResponse): boolean;
    abort(_reason?: Error): void;
    private finish;
}
