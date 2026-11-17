import { type FileOperation } from './ctrl.js';
import { type prepareUpload } from './mutations.js';
/** Encode one bounded IOCtrl; caller supplies the independent AV and request counters. */
export declare function encodeIoControl(type: number, body: Buffer, packetSequence: number, requestIndex: number): Buffer;
/** Encode one multi-slice IOCtrl. Counters advance independently for each slice. */
export declare function encodeIoControlSlices(type: number, body: Buffer, packetSequence: number, sliceCounter: number, requestIndex: number): Buffer[];
export declare function encodeProbeAck(clock: number, received: number): Buffer;
export declare function encodeAvLogin(mode: 'framed' | 'legacy', step: 0 | 32, nonce: number, password: string, uid: string): Buffer;
export declare function encodeInitialProbe(sequence: number, clock: number): Buffer;
export declare function encodeInitialHeartbeat(sequence: number, clock: number): Buffer;
/** RFC-style 16-bit sequence comparison; exactly half a cycle is not newer.
 * Source wire behavior: TutkSession.cpp 425–428 at pinned revision 77de55a. */
export declare function isNewerStreamCounter(current: number, previous: number): boolean;
export interface AvDatagramChannel {
    send(data: Buffer): Promise<void>;
    authorize?(): Promise<void>;
    verify?(): void;
    onData(callback: (data: Buffer) => void): () => void;
}
export type AvOperation = {
    operation: 'camera';
} | FileOperation | {
    operation: 'upload';
    job: ReturnType<typeof prepareUpload>;
    storage: 'emmc' | 'udisk';
};
export type AvResult = {
    kind: 'camera';
    frames: Buffer[];
} | {
    kind: 'files';
    value: unknown;
};
export declare function runAvSession(channel: AvDatagramChannel, password: string, operation: AvOperation, signal: AbortSignal, onReady?: () => void, uid?: string, onHandoff?: () => void, onUploadAck?: () => void): Promise<AvResult>;
