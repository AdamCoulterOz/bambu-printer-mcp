export declare function inspectRemoteArchive(bytes: Buffer, member?: string): Promise<{
    entries: string[];
    bytes?: Buffer;
}>;
