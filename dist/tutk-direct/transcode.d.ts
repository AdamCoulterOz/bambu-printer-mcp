export declare function transcode(input: Uint8Array, direction: 'encode' | 'decode'): Buffer;
/** The first header block is always scrambled; remaining data packets stop at byte 64. */
export declare function decodeDatagram(raw: Buffer): Buffer;
