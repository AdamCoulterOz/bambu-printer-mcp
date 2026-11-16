import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { HttpSessionOptions } from './http-sessions.js';
/** Stateless wire tickets hold compatibility metadata; only in-flight exchanges occupy memory. */
type HttpOptions = HttpSessionOptions & {
    serverInfo?: {
        name: string;
        version: string;
    };
    instructions?: string;
    shutdownWaitMs?: number;
    modernPendingTimeoutMs?: number;
    abortGraceMs?: number;
    onUnsettled?: () => void;
};
export declare class HttpRequests {
    private readonly options;
    private readonly factory;
    readonly httpServer: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    private readonly secret;
    private readonly active;
    private readonly prompts;
    private admitted;
    private modern;
    private modernNode;
    private closePromise?;
    private pending;
    private httpRequests;
    private controls;
    private denials;
    private closing;
    constructor(options: HttpOptions, factory: () => Server);
    private createOperation;
    reserveOperation(): (() => void) | undefined;
    stats(): {
        activeRequests: number;
        admittedOperations: number;
        modern: {
            activeOperations: number;
            pendingContinuations: number;
        };
        pendingInitializations: number;
        pendingInputs: number;
        controlRequests: number;
        denials: number;
    };
    listen(): Promise<void>;
    private ticket;
    private verify;
    private validHost;
    private denied;
    private handle;
    close(): Promise<void>;
}
export {};
