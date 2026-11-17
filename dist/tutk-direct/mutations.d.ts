export declare function deleteRequest(path: string, confirm: boolean, sequence?: number): Buffer;
export declare function correlatedMutationReply(value: unknown, command: 3 | 5, sequence: number): number;
export declare function prepareUpload(source: Buffer, name: string, storage: 'emmc' | 'udisk', allowHistoryRotation: boolean, sequence?: number, externalCapabilityVerified?: boolean): {
    remoteName: string;
    size: number;
    md5: string;
    sha256: string;
    init: Buffer<ArrayBuffer>;
    chunks(chunkKiB: number, offset: number): Buffer[];
};
export declare class UploadRejected extends Error {
}
/** One-shot upload receipt state; caller owns I/O and must never replay a handoff. */
export declare class UploadReceipt {
    private readonly job;
    private readonly sequence;
    private stage;
    constructor(job: ReturnType<typeof prepareUpload>, sequence?: number);
    initialized(value: unknown): Buffer[];
    completed(value: unknown): void;
    verified(bytes: Buffer): {
        status: 'verified';
        size: number;
        sha256: string;
        md5: string;
    };
    unreadable(): {
        status: 'uploaded_unverified';
        reason: 'readback_unavailable';
    };
}
export type MutationReceipt = {
    status: 'not_sent' | 'rejected' | 'acknowledged' | 'uploaded_unverified' | 'verified' | 'unknown';
    operation: 'upload' | 'delete';
    path: string;
    retryable: false;
    historyEffectsUncertain?: boolean;
    fileEffectsUncertain?: boolean;
    historyRotationAllowed?: boolean;
    sha256?: string;
    md5?: string;
    size?: number;
    reason?: string;
};
export declare class MutationFailure extends Error {
    readonly receipt: MutationReceipt;
    constructor(receipt: MutationReceipt);
}
/** The mutation marker is set synchronously before effectful I/O and cannot reset. */
export declare class MutationHandoff {
    private readonly operation;
    private readonly path;
    private readonly digest?;
    private sent;
    constructor(operation: 'upload' | 'delete', path: string, digest?: {
        sha256: string;
        md5: string;
        size: number;
        historyRotationAllowed?: boolean;
    } | undefined);
    beforeSend(): void;
    receipt(status: 'rejected' | 'acknowledged' | 'uploaded_unverified' | 'verified' | 'unknown' | 'not_sent', reason?: string): MutationReceipt;
    failure(): MutationFailure;
}
