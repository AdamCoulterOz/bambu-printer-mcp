import { openLanIotc } from './iotc.js';
import { openRelayIotc } from './relay.js';
import { connectDtls } from './dtls.js';
import { runAvSession } from './av.js';
import { type MutationReceipt, type prepareUpload } from './mutations.js';
export type DirectRequest = {
    session: {
        uid: string;
        authkey: string;
        passwd: string;
        region: string;
        device: string;
    };
    operation: 'camera' | 'list' | 'download' | 'delete' | 'upload';
    confirm?: true;
    onHandoff?: () => void;
    onUploadAck?: () => void;
    assertAuthority?: () => void | Promise<void>;
    assertAuthoritySync?: () => void;
    job?: ReturnType<typeof prepareUpload>;
    kind?: 'model' | 'video' | 'timelapse';
    storage?: string;
    path?: string;
    expectedSize?: number;
};
export type DirectResult = {
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
export type DirectStage = 'validation' | 'discovery' | 'rendezvous' | 'handshake' | 'auth' | 'transfer' | 'cancel';
export declare class DirectTutkError extends Error {
    readonly stage: DirectStage;
    readonly code: string;
    constructor(stage: DirectStage);
}
export declare function decodeCameraFrames(frames: Buffer[], signal: AbortSignal): Promise<Buffer>;
type DirectDependencies = {
    openLan: typeof openLanIotc;
    openRelay: typeof openRelayIotc;
    connect: typeof connectDtls;
    av: typeof runAvSession;
    decode: typeof decodeCameraFrames;
};
/** Callers own account/ticket acquisition; this function owns all media network state. */
export declare function runDirectTutk(request: DirectRequest, signal?: AbortSignal): Promise<DirectResult>;
/** Injected dependencies are for isolated lifecycle tests only. */
export declare function runDirectTutkForTest(request: DirectRequest, signal: AbortSignal | undefined, deps: DirectDependencies): Promise<DirectResult>;
export {};
