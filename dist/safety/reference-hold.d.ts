/** The OS lock serializes starts across processes sharing this private state. */
export declare function withPrintStartGuard<T>(serial: string, fn: () => Promise<T>): Promise<T>;
/** Call under withPrintStartGuard, synchronously before transport handoff. */
export declare function markReferenceUnknown(serial: string): string;
export declare function discardUnsentReferenceHold(serial: string, nonce: string): void;
/** Call under the same print guard; failure leaves the durable unknown hold. */
export declare function bindReferenceTask(serial: string, id: string): void;
export declare function inspectReferenceHold(serial: string): Promise<{
    state: 'none' | 'unknown' | 'pending';
    taskId?: string;
    nonce?: string;
}>;
/** Caller supplies a fresh observed-serial report acquired without holding this lock. */
export declare function observeReferenceHold(serial: string, status: any): Promise<'none' | 'unknown' | 'pending'>;
/** Explicit human recovery checks the exact hold observed before confirmation. */
export declare function clearReferenceHold(serial: string, nonce: string, withAuthority: (removeHold: () => void) => Promise<void>, signal?: AbortSignal): Promise<void>;
