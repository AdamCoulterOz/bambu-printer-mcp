import type { CompletedJobReference, CurrentMapping } from './reprint.js';
import type { PrinterStateRequirements } from '../safety/printer-state.js';
import type { PrintPreflight } from '../printers/bambu.js';
type Account = {
    fetchTask(id: string): Promise<unknown>;
    fetchProfile(modelId: string, profileId: number): Promise<unknown>;
    assertCurrent(recheckBinding?: boolean): Promise<void>;
    dispatch(payload: Record<string, unknown>, headers: Record<string, string>, onDispatch: () => void): Promise<string>;
};
export declare class ReferenceDispatchUnknown extends Error {
    readonly receipt: {
        sourceTaskId: string;
        fingerprint: string;
        verification: 'provider_completed_job_reference';
        mappingSource: 'historical' | 'explicit_current_selection';
        dispatch: 'unknown';
    };
    constructor(reference: CompletedJobReference);
}
/** Preserve original one-based project filament IDs as zero-based global positions. */
export declare function referenceRequirements(reference: CompletedJobReference): PrinterStateRequirements;
export interface ReferenceExecution {
    account: Account;
    serial: string;
    taskId: string;
    signal?: AbortSignal;
    assertActive(): void;
    currentMapping?: CurrentMapping;
    readStatus(): Promise<unknown>;
    confirm(status: unknown, reference: CompletedJobReference): Promise<PrintPreflight>;
    assertPreflight(status: unknown, preflight: PrintPreflight): void;
    headers(): Promise<Record<string, string>>;
    prepareHandoff(): string;
    discardHandoff(nonce: string): void;
    onDispatch(): void;
    onAccepted(taskId: string): void;
}
/** Exactly one dispatch, after three independent fresh status reads and a renewed provider reference. */
export declare function executeReferenceReprint(x: ReferenceExecution): Promise<{
    sourceTaskId: string;
    newTaskId: string;
    fingerprint: string;
    verification: 'provider_completed_job_reference';
    mappingSource: 'historical' | 'explicit_current_selection';
    dispatch: 'unconfirmed';
}>;
export {};
