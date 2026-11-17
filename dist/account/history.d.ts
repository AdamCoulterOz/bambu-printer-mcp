/** Handy's task listing is an offset/limit account endpoint with a deviceId filter:
 * decompiled defpackage/sfn.java, method c. Never trust that filter without
 * checking each returned row. Totals refer to the filtered upstream query. */
type Json = Record<string, unknown>;
export interface HistoryPageOptions {
    offset?: number;
    limit?: number;
}
export declare function historyPageRequest(serial: string, options?: HistoryPageOptions): {
    path: string;
    offset: number;
    limit: number;
};
export declare function projectHistoryPage(result: Json, serial: string, offset: number, limit: number): Json;
export {};
