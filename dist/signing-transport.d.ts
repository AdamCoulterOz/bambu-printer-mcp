import * as mqtt from "mqtt";
import { AccountManager } from "./account/index.js";
import type { CommandInput } from "./signing/index.js";
/** The cryptographic session owns trust validation and the persistent sequence. */
export interface SigningSession {
    beginInstall(generation: number): Promise<{
        sequence: string | number;
        payload: Buffer;
    }>;
    acceptInstallReply(input: {
        topic: string;
        generation: number;
        reply: unknown;
    }): Promise<boolean>;
    signCommand(command: CommandInput): Promise<Buffer>;
    disconnect(): void;
    readiness(): {
        state: string;
        reason: string;
        expiresAt?: string;
    };
}
export interface SignedTransportOptions {
    serial: string;
    url: string;
    username: string;
    password: string;
    sessionFactory: () => Promise<SigningSession>;
    connect?: typeof mqtt.connect;
    timeoutMs?: number;
    tlsCa?: Buffer;
    tlsServername?: string;
    beforePublish?: () => Promise<void>;
    onPublish?: () => void;
    assertActive?: () => void;
    accountGuard?: {
        assertCurrent(): Promise<void>;
        assertGenerationCurrent(): void;
    };
}
/** A private, one-shot writer. MQTT reconnect and offline command queues are disabled. */
export declare class SignedTransport {
    private readonly options;
    private generation;
    private tail;
    private current?;
    constructor(options: SignedTransportOptions);
    close(): void;
    send(command: CommandInput, signal?: AbortSignal): Promise<void>;
    sendLight(light: string, mode: string, signal?: AbortSignal): Promise<void>;
    private sendOnce;
}
/** Parse the operator's explicit choice at the boundary. No connection occurs here. */
export declare function signedControlConfiguration(env: NodeJS.ProcessEnv, host: string, lanToken: string): undefined | {
    url: string;
    username: string;
    password: string;
    operatorPemDirectory: string;
    deviceCaFile: string;
    sequenceStore: string;
    localTlsCaFile?: string;
    localTlsServername?: string;
    accountGuard?: {
        assertCurrent(): Promise<void>;
        assertGenerationCurrent(): void;
    };
};
export declare function sendSignedControl(config: NonNullable<ReturnType<typeof signedControlConfiguration>>, serial: string, command: CommandInput, signal?: AbortSignal, beforePublish?: () => Promise<void>, assertActive?: () => void, onPublish?: () => void): Promise<void>;
export declare function sendTypedLight(config: NonNullable<ReturnType<typeof signedControlConfiguration>>, serial: string, light: string, mode: string, signal?: AbortSignal): Promise<void>;
/** Opt-in selection also treats malformed values as selected so writes fail closed. */
export declare function signedControlsRequested(env: NodeJS.ProcessEnv): boolean;
export declare const accountManager: AccountManager;
export declare function resolveSignedControlConfiguration(env: NodeJS.ProcessEnv, host: string, lanToken: string, serial: string, account?: Pick<AccountManager, 'getCloudMqttCredentials'>): Promise<ReturnType<typeof signedControlConfiguration>>;
