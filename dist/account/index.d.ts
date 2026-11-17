import { type CloudFilamentInventory } from '../filament-library.js';
import { type HistoryPageOptions } from './history.js';
/** Community-documented Bambu cloud protocol; no Studio or Home Assistant session is used. */
export type AccountRegion = 'global' | 'china';
export interface CloudMqttCredentials {
    url: string;
    username: string;
    password: string;
    assertCurrent(): Promise<void>;
    assertGenerationCurrent(): void;
}
export interface BoundPrinter {
    serial: string;
    name: string;
    model: string;
}
type Json = Record<string, unknown>;
interface ActionAuthority {
    generation: number;
    signal: AbortSignal;
}
export interface AccountVendor {
    request(region: AccountRegion, path: string, body?: Json, token?: string, signal?: AbortSignal): Promise<Json>;
    verifyTotp?(region: AccountRegion, key: string, code: string): Promise<Json>;
    resendPhone?(phone: string): Promise<void>;
}
export declare class AccountManager {
    private readonly directory;
    private readonly vendor;
    private readonly lockObserver?;
    private starting?;
    private flowGeneration;
    private authorityGeneration;
    private authorityAbort;
    private logoutInProgress;
    private beginAction;
    private assertAction;
    private invalidateAuthority;
    private writes;
    private active?;
    constructor(options?: {
        sessionDirectory?: string;
        vendor?: AccountVendor;
        lockObserverForTest?: (pid: number) => void;
    });
    private get file();
    private load;
    status(): Promise<{
        state: 'not_configured' | 'ready' | 'expired';
        region?: AccountRegion;
        expiresAt?: string;
        loginInProgress: boolean;
        refreshState: 'unavailable' | 'available' | 'reauth_required';
    }>;
    private enqueueWrite;
    private authorityEpoch;
    private advanceEpoch;
    private save;
    private session;
    private identity;
    private atomicSession;
    private refreshSession;
    listFilamentInventory(env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CloudFilamentInventory>;
    private listFilamentInventoryAttempt;
    private accountActions;
    private historyLastAttempt;
    private historyAuthority;
    private historyCached?;
    private readonly historyPages;
    private accountTuple;
    private captureAdmission;
    private verifyAdmission;
    /** Secret-bearing, single-action capability for owned completed-job reads and one dispatch. */
    beginCompletedJobAccount(serial: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{
        fetchTask(id: string): Promise<unknown>;
        fetchProfile(modelId: string, profileId: number): Promise<unknown>;
        assertCurrent(recheckBinding?: boolean): Promise<void>;
        assertGenerationCurrent(): void;
        withLockedAuthority<T>(operation: () => T): Promise<T>;
        dispatch(payload: Record<string, unknown>, headers: Record<string, string>, onDispatch: () => void): Promise<string>;
    }>;
    private accountOperationCredentials;
    private performAccountRequest;
    /** Account-only operations are serialized without automatically retrying a mutation. */
    filamentAction(operation: string, payload: unknown, serial: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Json>;
    cloudPrintHistory(serial: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Json>;
    /** One bounded printer-filtered upstream page; the caller carries next_offset. */
    cloudPrintHistoryPage(serial: string, options?: HistoryPageOptions, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Json>;
    cloudPrintHistoryCover(serial: string, taskId: number | string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{
        bytes: Buffer;
        mimeType: 'image/jpeg' | 'image/png';
    }>;
    listPrinters(): Promise<BoundPrinter[]>;
    private boundPrinters;
    /** Secret-bearing adapter boundary. Never return this object from an MCP tool. */
    getCloudMqttCredentials(serial: string, signal?: AbortSignal, action?: ActionAuthority): Promise<CloudMqttCredentials>;
    private cloudMqttCredentialsForSession;
    /**
     * Resolve the configured cloud writer's account identity for internal adapters.
     * A complete explicit tuple has precedence over an interactive account session.
     */
    getConfiguredCloudMqttCredentials(serial: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, action?: ActionAuthority): Promise<CloudMqttCredentials>;
    logout(): Promise<void>;
    cancelInteractiveLogin(): void;
    beginInteractiveLogin({ region }: {
        region: AccountRegion;
    }): Promise<{
        flowId: string;
        url: string;
        expiresAt: string;
    }>;
}
export {};
