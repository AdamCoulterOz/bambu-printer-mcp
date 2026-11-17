/** IOTC UDP transport and LAN discovery. Wire facts: open-bamboo-networking
 * 77de55a, research/06.07-tutk.md and IotcClient.cpp:385–445,2100–2230.
 * All datagrams are bounded and checked against the selected peer and token. */
import dgram from 'node:dgram';
export type Peer = {
    address: string;
    port: number;
};
type Item = {
    data: Buffer;
    peer: Peer;
};
export interface IotcTransport {
    send(data: Buffer, epoch: number, sequence: number, signal?: AbortSignal): Promise<void>;
    receive(deadline: number, signal?: AbortSignal): Promise<Buffer | undefined>;
    close(graceful?: boolean): Promise<void>;
}
export declare function lanTargets(): string[];
export declare function discoveryPacket(uid: string, authkey: string, token: Buffer): Buffer;
export declare function encodeData(record: Buffer, token: Buffer, epoch: number, sequence: number): Buffer;
export declare class SocketQueue {
    readonly socket: dgram.Socket;
    private q;
    private wake?;
    private dead;
    constructor(socket: dgram.Socket);
    next(deadline: number, signal?: AbortSignal): Promise<Item | undefined>;
}
export declare function sendDatagram(socket: dgram.Socket, p: Buffer, peer: Peer): Promise<void>;
/** Internal test seam accepts a fixed target; production uses interface broadcasts. */
export declare function openLanIotc(uid: string, authkey: string, signal: AbortSignal, targets?: Peer[], timeout?: number): Promise<IotcTransport>;
export declare function closeSocket(socket: dgram.Socket): Promise<void>;
export declare function makeIotcTransport(socket: dgram.Socket, queue: SocketQueue, destination: Peer, token: Buffer, relayTag: number | undefined): IotcTransport;
export {};
