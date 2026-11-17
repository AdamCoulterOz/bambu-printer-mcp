import { get } from 'node:https';
export declare function isPublicCoverAddress(address: string): boolean;
export declare function validateCoverUrl(value: unknown): URL;
/** Downloads a task-owned URL with one verified DNS address pinned to the TLS
 * connection; redirects and credentials are never forwarded or exposed. */
export declare function readHistoryCover(value: unknown, signal?: AbortSignal, dependencies?: {
    resolve?: (host: string) => Promise<{
        address: string;
        family: number;
    }[]>;
    request?: typeof get;
}): Promise<{
    bytes: Buffer;
    mimeType: 'image/jpeg' | 'image/png';
}>;
