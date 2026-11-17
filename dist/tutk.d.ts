import type { CloudMqttCredentials } from './account/index.js';
import { prepareUpload, type MutationReceipt } from './tutk-direct/mutations.js';
import { createHttpProof, handyClientHeaders } from './signing/http-proof.js';
export type TutkOperation = {
    operation: 'camera';
} | {
    operation: 'list';
    kind: 'model' | 'video' | 'timelapse';
    storage: '' | 'internal' | 'external' | 'emmc' | 'udisk' | 'sdcard' | 'usb';
} | {
    operation: 'download';
    path: string;
} | {
    operation: 'delete';
    path: string;
    confirm: true;
    kind: 'model' | 'video' | 'timelapse';
    storage: '' | 'internal' | 'external' | 'emmc' | 'udisk' | 'sdcard' | 'usb';
    expectedSize?: number;
} | {
    operation: 'upload';
    bytes: Buffer;
    name: string;
    storage: 'emmc' | 'udisk';
    allowHistoryRotation: boolean;
    externalCapabilityVerified?: boolean;
};
type Session = {
    uid: string;
    authkey: string;
    passwd: string;
    region: string;
    device: string;
};
type DirectRequest = TutkOperation & {
    session: Session;
    onHandoff?: () => void;
    onUploadAck?: () => void;
    assertAuthority?: () => void | Promise<void>;
    assertAuthoritySync?: () => void;
    job?: ReturnType<typeof prepareUpload>;
};
type Dependencies = {
    credentials(serial: string): Promise<CloudMqttCredentials>;
    fetch?: typeof fetch;
    proof?: typeof createHttpProof;
    headers?: typeof handyClientHeaders;
    onLockChild?: (pid: number) => void;
    execute?: (request: DirectRequest, signal: AbortSignal) => Promise<TutkResult>;
};
export type RemoteMediaStage = 'lock' | 'account' | 'proof' | 'ticket' | 'direct' | 'validation';
/** Deliberately excludes the underlying cause, endpoint, and credential-bearing data. */
export declare class RemoteMediaError extends Error {
    readonly stage: RemoteMediaStage;
    readonly code: string;
    constructor(stage: RemoteMediaStage);
}
export type TutkResult = {
    kind: 'upload';
    receipt: MutationReceipt;
    actualPath: string | null;
} | {
    kind: 'delete';
    receipt: MutationReceipt;
} | {
    kind: 'camera';
    jpeg: Buffer;
} | {
    kind: 'download';
    bytes: Buffer;
    size: number;
    md5: string;
} | {
    kind: 'list';
    files: Array<{
        name?: string;
        path?: string;
        size?: number;
        time?: number;
        date?: string;
        type: 'model' | 'video' | 'timelapse';
    }>;
};
/** A fresh ticket authorizes one direct read; no MQTT watcher or duplicate prepare. */
export declare function runTutkOperation(options: {
    serial: string;
    signingDirectory: string;
    stateDirectory: string;
    osVersion: string;
    lockFile: string;
    operation: TutkOperation;
    signal?: AbortSignal;
}, deps: Dependencies): Promise<TutkResult>;
/** Read an archive once through the authenticated bounded download, then inspect
 * the immutable verified bytes locally; no printer mutation or extra ticket. */
export declare function runRemoteArchive(options: Omit<Parameters<typeof runTutkOperation>[0], 'operation'> & {
    path: string;
    member?: string;
}, deps: Dependencies): Promise<{
    entries: string[];
    bytes?: Buffer;
}>;
export {};
