/** Cancellation follows the individual operation through shared queues and connection awaits. */
export declare function withOperationSignal<T>(signal: AbortSignal, run: () => T): T;
export declare function assertOperationActive(): void;
