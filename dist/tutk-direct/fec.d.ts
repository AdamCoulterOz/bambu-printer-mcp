/** Recover missing data shards. Input is bounded and never modified. */
export declare function recoverDataShards(k: number, shards: ReadonlyMap<number, Uint8Array>, length: number): Buffer[];
