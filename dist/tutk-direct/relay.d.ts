import { resolve4 } from 'node:dns/promises';
import { type IotcTransport } from './iotc.js';
type Credentials = {
    uid: string;
    authkey: string;
    region: string;
};
export declare function openRelayIotc(credentials: Credentials, signal: AbortSignal, dns?: typeof resolve4): Promise<{
    transport: IotcTransport;
    sendProbe?: () => Promise<void>;
}>;
export {};
