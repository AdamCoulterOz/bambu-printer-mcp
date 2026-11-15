import { SigningSession } from './session.js';
export { SigningSession } from './session.js';
export type { ConnectionGeneration, SigningReadiness, CommandInput } from './session.js';
export { SigningError } from './pki.js';
export type SigningOptions = {
    serial: string;
    operatorPemDirectory: string;
    /** Independent vendor device trust CA bundle contents; never the app CA. */
    deviceTrustPem: string;
    /** Absolute private directory initialized by signing-setup. Stable across key rotation. */
    sequenceStore?: string;
    /** Trusted internal clock in Unix epoch milliseconds. */
    clock?: () => number;
};
export declare function createSigningSession(options: SigningOptions): Promise<SigningSession>;
