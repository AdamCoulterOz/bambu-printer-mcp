import { type ConnectionOptions, type TLSSocket } from 'node:tls';
export interface VerifiedInternalUpload {
    storage: 'emmc';
    name: string;
    size: number;
    md5: string;
    sha256: string;
    url: string;
    verifiedBy: 'readback';
}
export interface VerifiedUploadInternalOptions {
    host: string;
    serial: string;
    accessCode: string;
    ca: Buffer;
    servername?: string;
    filePath: string;
    snapshotSha256: string;
    /** A unique, UUID-bearing flat basename chosen by the caller. */
    remoteName: string;
    signal?: AbortSignal;
    assertActive: () => void;
    deadlineMs?: number;
    progress?: (progress: {
        phase: 'upload' | 'readback';
        bytes: number;
        total: number;
    }) => void;
}
export interface MediaTransferDependencies {
    /** Test seam only; production always uses node:tls with strict verification. */
    connect: (options: ConnectionOptions) => TLSSocket;
}
type Stage = 'local' | 'tls' | 'login' | 'setup' | 'capability' | 'list' | 'upload' | 'readback';
type Failure = 'invalid-options' | 'local-changed' | 'tls' | 'closed' | 'timeout' | 'cancelled' | 'protocol' | 'bounds' | 'unsupported' | 'collision' | 'remote-rejected' | 'integrity';
export declare class MediaTransferError extends Error {
    readonly stage: Stage;
    readonly reason: Failure;
    readonly uploadMayExist: boolean;
    constructor(stage: Stage, reason: Failure, uploadMayExist: boolean);
}
export declare function verifiedUploadInternal(options: VerifiedUploadInternalOptions, dependencies?: MediaTransferDependencies): Promise<VerifiedInternalUpload>;
export {};
