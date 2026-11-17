export declare function buildCloudProjectMedia(snapshot: Buffer, plate: number, expectedSha256: string): Promise<{
    config3mf: Buffer;
    sha256: string;
    plate: number;
}>;
