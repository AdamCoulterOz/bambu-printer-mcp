import { get } from 'node:https';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
/** Resolve one immutable generation at session creation. Legacy direct PEMs remain supported. */
export declare function resolveSigningDirectory(directory: string): Promise<string>;
export declare function acquireSigningLockForTest(directory: string): Promise<ChildProcessWithoutNullStreams>;
/** Internal transport seam for deterministic timeout testing; callers cannot select
 * an endpoint through an MCP tool. Production always uses the fixed hosts below. */
export declare function requestCredentialForTest(url: URL, transport?: typeof get, deadlineMs?: number, signal?: AbortSignal): Promise<Buffer>;
/** Internal wire primitives; production validates the wrapping pin before use. */
export declare function encodeCredentialRequest(bootstrap: string, publicKey: import('node:crypto').KeyObject, aes: Buffer, iv: Buffer): {
    encrypted: Buffer;
    wrapped: Buffer;
};
export declare function decryptCredentialKey(encoded: string, aes: Buffer): Buffer;
export type ProvisionSigningOptions = {
    directory: string;
    bootstrapFile: string;
    wrappingCertificateFile: string;
    region: 'global' | 'cn';
    persistSource?: boolean;
    expectedGeneration?: string;
    signal?: AbortSignal;
};
export type AutoRenewSigningOptions = {
    directory: string;
    region: 'global' | 'cn';
    bootstrapFile?: string;
    wrappingCertificateFile?: string;
};
/** Each call deliberately issues a new generation; no implicit retries or network on startup. */
export declare function provisionSigningCredentials(options: ProvisionSigningOptions, automatic?: boolean): Promise<{
    expiresAt: string;
}>;
/** Internal test seam only; MCP and production callers cannot supply these dependencies. */
export declare function provisionSigningCredentialsForTest(options: ProvisionSigningOptions, automatic: boolean, dependencies: {
    request: (url: URL) => Promise<Buffer>;
    appPin: string;
    wrapPin: string;
    clock: () => number;
}): Promise<{
    expiresAt: string;
}>;
/** Extract from a verified operator APK, then atomically bind its private source
 * to the published credential generation. No random source directory remains. */
export declare function provisionSigningCredentialsFromApk(options: {
    directory: string;
    apkFile: string;
    region: 'global' | 'cn';
    signal?: AbortSignal;
}): Promise<{
    expiresAt: string;
}>;
/** Explicit one-click setup from the fixed, reviewed official package. */
export declare function provisionSigningCredentialsFromOfficialPackage(options: {
    directory: string;
    region: 'global' | 'cn';
    signal?: AbortSignal;
}): Promise<{
    expiresAt: string;
}>;
/** Internal seam to exercise acquisition, cleanup and issuance ordering offline. */
export declare function provisionOfficialPackageForTest(options: {
    directory: string;
    region: 'global' | 'cn';
    signal?: AbortSignal;
}, dependencies: {
    download: (path: string, signal?: AbortSignal) => Promise<void>;
    provision: typeof provisionSigningCredentialsFromApk;
}): Promise<{
    expiresAt: string;
}>;
/** On-demand automatic renewal, only when explicitly configured. A still valid
 * current bundle remains usable if renewal fails; invalid or revoked never does.
 * Attempts are durably throttled across processes and never retried by a call. */
export declare function ensureManagedSigningCredentials(options: AutoRenewSigningOptions): Promise<void>;
/** Internal synthetic authority seam; production always fixes pins and transport. */
export declare function ensureManagedSigningCredentialsForTest(options: AutoRenewSigningOptions, dependencies: {
    request: (url: URL) => Promise<Buffer>;
    appPin: string;
    wrapPin: string;
    clock: () => number;
}): Promise<void>;
