import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
/** A deliberately small, stable error surface: never include URLs or OS error text. */
export declare class WorkspaceArtifactError extends Error {
    code: string;
    next_action: string;
    constructor(code: string, message: string, next_action: string);
}
export declare const workspaceArtifactTools: Tool[];
/** The public route is fixed by deployment configuration, never by Host input. */
export declare function workspaceArtifactUploadPath(): string | undefined;
/**
 * Consume one opaque upload capability and stream raw bytes into its already
 * reserved private file. The capability is hashed in the ledger and removed
 * before reading the body, so it cannot be reused after a timeout or failure.
 */
export declare function handleWorkspaceArtifactUpload(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
export declare function handleWorkspaceArtifactTool(name: string, args: unknown, options?: {
    signal?: AbortSignal;
    assertAuthority?: () => void | Promise<void>;
}): Promise<Record<string, unknown>>;
