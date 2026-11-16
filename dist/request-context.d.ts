import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
export declare function trackRequest(server: Server, id: RequestId): void;
export declare function aliasRequest(server: Server, original: RequestId, internal: RequestId): void;
export declare function cancelTrackedRequest(server: Server, id: RequestId): void;
export declare function forgetRequest(server: Server, id: RequestId): void;
export declare function cancelSessionRequests(server: Server): void;
/** One shared backend, with ownership retained through queues and asynchronous callbacks. */
export declare function withRequestOwner<T>(server: Server, extra: {
    signal: AbortSignal;
    requestId: RequestId;
}, run: () => T): T;
export declare function requestOwner(): {
    server: Server;
    signal: AbortSignal;
    requestId: RequestId;
};
