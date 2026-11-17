type Obj = Record<string, unknown>;
export interface CloudPrintOptions {
    api: 'https://api.bambulab.com' | 'https://api.bambulab.cn';
    token: string;
    username: string;
    signingDirectory: string;
    clientHeaders: Record<string, string>;
    filePath: string;
    sha256: string;
    filename: string;
    plate: number;
    task: Obj;
    signal?: AbortSignal;
    beforeDispatch: () => Promise<void>;
    onDispatch: () => void;
    assertAuthority?: () => void;
    fetcher?: typeof fetch;
    proofFactory?: (directory: string) => Promise<Record<string, string>>;
}
/** Mutations are never retried. In particular POST /my/task is itself a print dispatch. */
export declare function submitCloudPrint(o: CloudPrintOptions): Promise<{
    projectId: string;
    taskId: string;
    dispatch: 'unconfirmed';
    cover_source: 'selected_plate_config';
    cover_processing: 'unconfirmed';
}>;
export {};
