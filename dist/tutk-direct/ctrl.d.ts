export type FileOperation = {
    operation: 'list';
    kind: 'model' | 'video' | 'timelapse';
    storage: string;
} | {
    operation: 'download';
    path: string;
} | {
    operation: 'delete';
    path: string;
    confirm: true;
    kind: 'model' | 'video' | 'timelapse';
    storage: string;
    expectedSize?: number;
};
export declare function makeControlRequest(op: FileOperation): Buffer;
export declare class ControlReplies {
    private readonly operation;
    private readonly sequence;
    private done;
    private files;
    private chunks;
    private size;
    private total?;
    private listBytes;
    constructor(operation: FileOperation, sequence?: number);
    consume(frame: Buffer): unknown | undefined;
}
