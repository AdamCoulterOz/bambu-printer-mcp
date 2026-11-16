import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { type AuthInfo } from '@modelcontextprotocol/server';
import { ActiveOperation, type ActiveOperationOptions } from './http-operation.js';
type AdapterOptions = {
    createProtocolServer: () => LegacyServer;
    maxActive?: number;
    pendingTimeoutMs?: number;
    reserveOperation?: () => (() => void) | undefined;
    serverInfo?: {
        name: string;
        version: string;
    };
    instructions?: string;
    createOperation?: (options: ActiveOperationOptions) => ActiveOperation;
};
/** Modern per-request frontend. The only retained state belongs to active operations. */
export declare function createModernHttpAdapter(options: AdapterOptions): {
    fetch: (request: Request, opts?: {
        parsedBody?: unknown;
        authInfo?: AuthInfo;
    }) => Promise<Response>;
    stats: () => {
        activeOperations: number;
        pendingContinuations: number;
    };
    close: () => Promise<void>;
};
export {};
