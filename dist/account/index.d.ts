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
export interface AccountVendor {
    request(region: AccountRegion, path: string, body?: Json, token?: string): Promise<Json>;
    verifyTotp?(region: AccountRegion, key: string, code: string): Promise<Json>;
    resendPhone?(phone: string): Promise<void>;
}
export declare class AccountManager {
    private readonly directory;
    private readonly vendor;
    private starting?;
    private flowGeneration;
    private authorityGeneration;
    private writes;
    private active?;
    constructor(options?: {
        sessionDirectory?: string;
        vendor?: AccountVendor;
    });
    private get file();
    private load;
    status(): Promise<{
        state: 'not_configured' | 'ready' | 'expired';
        region?: AccountRegion;
        expiresAt?: string;
        loginInProgress: boolean;
    }>;
    private enqueueWrite;
    private save;
    private session;
    listPrinters(): Promise<BoundPrinter[]>;
    private boundPrinters;
    /** Secret-bearing adapter boundary. Never return this object from an MCP tool. */
    getCloudMqttCredentials(serial: string): Promise<CloudMqttCredentials>;
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
