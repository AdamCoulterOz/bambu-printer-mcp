export declare class FrameReceiver {
    private readonly emit;
    private readonly ordered;
    private groups;
    private frames;
    private delivered;
    private next?;
    private pendingBytes;
    constructor(emit: (frame: Buffer, key: boolean) => void, ordered?: boolean);
    private deliver;
    private drain;
    private slice;
    /** Accept one authenticated AV stream packet. Returns an embedded probe clock, if present. */
    accept(packet: Buffer): number | undefined;
}
