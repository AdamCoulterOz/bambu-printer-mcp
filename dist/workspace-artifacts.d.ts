import { type Tool } from '@modelcontextprotocol/sdk/types.js';
/** A deliberately small, stable error surface: never include URLs or OS error text. */
export declare class WorkspaceArtifactError extends Error {
    code: string;
    next_action: string;
    constructor(code: string, message: string, next_action: string);
}
export declare const workspaceArtifactTools: Tool[];
export declare function handleWorkspaceArtifactTool(name: string, args: unknown, options?: {
    signal?: AbortSignal;
    assertAuthority?: () => void | Promise<void>;
}): Promise<Record<string, unknown>>;
