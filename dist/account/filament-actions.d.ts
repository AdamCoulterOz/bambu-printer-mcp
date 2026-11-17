/** Account Filament Manager request validation and bounded result projection. */
type RecordValue = Record<string, unknown>;
export interface AccountRequest {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: RecordValue;
}
export declare function prepareFilamentAction(operation: unknown, payload: unknown, serial: string): AccountRequest;
export declare function projectAccountResponse(value: unknown, depth?: number): unknown;
export declare function classifyFilamentResult(operation: string, body: RecordValue | undefined, response: RecordValue): string;
export {};
