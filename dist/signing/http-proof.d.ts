import { type AutoRenewSigningOptions } from './bootstrap.js';
/** Parse explicit configuration without reading files or contacting the network. */
export declare function httpProofRenewalConfiguration(env: NodeJS.ProcessEnv, directory: string): AutoRenewSigningOptions | undefined;
/** Creates short-lived proof only after validating key, certificate and CRL. Never expose to MCP callers. */
export declare function createHttpProof(directory: string, clock?: () => number, autoRenew?: AutoRenewSigningOptions): Promise<Record<string, string>>;
/** Android Handy 4.4.1 (APK SHA-256 88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506),
 * BblHeaderInterceptor.java:175-199; device identity is application-owned. */
export declare function handyClientHeaders(stateDirectory: string, osVersion: string): Promise<Record<string, string>>;
