/**
 * The DTLS 1.2 client profile used inside an established Bambu IOTC path.
 * Wire reference: open-bamboo-networking 77de55a8c696c53125ca297bdf3fdf1258772335,
 * research/06.07-tutk.md §6.7.2 and src/camera/tutk/IotcClient.cpp:554–1297.
 * The injected transport handles IOTC envelopes, peer selection and socket lifetime.
 */
export declare class DtlsError extends Error {
}
export interface DtlsTransport {
    /** Send a single DTLS datagram in its IOTC envelope. */
    send(data: Buffer, epoch: number, sequence: number, signal?: AbortSignal): Promise<void>;
    /** Supply one datagram from the selected IOTC peer. */
    receive(deadline: number, signal?: AbortSignal): Promise<Buffer | undefined>;
}
export interface DtlsOptions {
    /** Absolute operation deadline on the `performance.now()` clock. */
    deadline: number;
    /** Separate handshake cap in milliseconds. Defaults to 15 seconds. */
    handshakeTimeoutMs?: number;
    signal?: AbortSignal;
    /** Off-LAN direct authentication, after the identical initial ClientHellos. */
    sendProbe?: (signal?: AbortSignal) => Promise<void>;
}
export interface DtlsSession {
    send(data: Buffer): Promise<void>;
    receive(deadline: number): Promise<Buffer | undefined>;
    close(): void;
}
/** Authenticate a peer over a selected IOTC path. The caller owns that path. */
export declare function connectDtls(transport: DtlsTransport, password: string, options: DtlsOptions): Promise<DtlsSession>;
