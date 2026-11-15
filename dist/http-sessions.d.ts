import { type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
export type HttpSessionOptions = {
    host: string;
    port: number;
    path: string;
    enableJsonResponse: boolean;
    allowedOrigins: Set<string>;
    allowedHosts?: Set<string>;
    bearerToken?: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
    maxBodyBytes?: number;
};
/** Read once at startup. The file and its contents are never exposed through diagnostics. */
export declare function httpBearerToken(env?: NodeJS.ProcessEnv): string | undefined;
/** Owns protocol sessions only. Shared printer/account/bridge cleanup belongs to the process owner. */
export declare class HttpSessions {
    private readonly options;
    private readonly createProtocolServer;
    readonly httpServer: HttpServer;
    private readonly sessions;
    private readonly pending;
    private readonly expiry;
    private closing?;
    private activeRequests;
    private controlRequests;
    constructor(options: HttpSessionOptions, createProtocolServer: () => Server);
    listen(): Promise<void>;
    private validHost;
    private handle;
    private expire;
    close(): Promise<void>;
}
