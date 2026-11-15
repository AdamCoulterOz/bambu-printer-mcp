import { type PrintCommand } from './wire.js';
import { type AppMaterial } from './pki.js';
import { SequenceStore } from './sequence.js';
export type ConnectionGeneration = string | number;
export type SigningReadiness = {
    state: 'DISCONNECTED' | 'INSTALLING' | 'READY' | 'BLOCKED';
    reason: string;
    expiresAt?: string;
};
export type CommandInput = Omit<PrintCommand, 'sequence_id'> & {
    command: PrintCommand['command'];
    sequence_id?: string;
};
/** Internal session; production callers obtain it through createSigningSession.
 * The adapter must recheck its connection generation immediately before publish.
 * Bytes returned by signCommand are dispatch authority only for that generation.
 */
export declare class SigningSession {
    private readonly serial;
    private readonly app;
    private readonly trustPem;
    private readonly sequences;
    private readonly clock;
    private epoch;
    private generation?;
    private pending?;
    private device?;
    private materialExpiry?;
    private reason;
    private state;
    constructor(serial: string, app: AppMaterial, trustPem: string, sequences: SequenceStore, clock?: () => number);
    private now;
    private alive;
    private current;
    readiness(): SigningReadiness;
    beginInstall(generation: ConnectionGeneration): Promise<{
        sequence: string;
        payload: Buffer;
    }>;
    acceptInstallReply(input: {
        topic: string;
        generation: ConnectionGeneration;
        reply: unknown;
    }): Promise<boolean>;
    signCommand(command: CommandInput): Promise<Buffer>;
    disconnect(): void;
}
