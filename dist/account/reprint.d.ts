type Material = {
    id: number;
    type: string;
    nozzle: number;
};
type Mapping2 = {
    amsId: number;
    slotId: number;
};
type Detail = {
    ams: number;
    amsId?: number;
    slotId?: number;
    nozzleId?: number;
    sourceColor?: string;
    targetColor?: string;
    filamentType?: string;
    targetFilamentType?: string;
    weight?: number;
};
export type CurrentMapping = {
    filamentId: number;
    ams: number;
    amsId: number;
    slotId: number;
}[];
export type CompletedJobReference = {
    verification: 'provider_completed_job_reference';
    sourceTaskId: string;
    sourceMode: 'cloud_file' | 'lan_file' | 'auto_repeat';
    payload: {
        mode: 'auto_repeat';
        deviceId: string;
        modelId: string;
        profileId: number;
        instanceId: number;
        plateIndex: number;
        bedType: string;
        useAms: boolean;
        isPublicProfile: boolean;
        amsMapping?: number[];
        amsMapping2?: Mapping2[];
        nozzleMapping?: number[];
        amsDetailMapping?: Detail[];
    };
    declared: {
        deviceModel: string;
        nozzleDiameters: number[];
        nozzleSource: 'task' | 'profile' | 'task_and_profile';
        materials: Material[];
        physicalNozzleIndices: number[];
        mappingSource: 'historical' | 'explicit_current_selection';
    };
    fingerprint: string;
};
export type ReferenceReads = {
    fetchTask(id: string): Promise<unknown>;
    fetchProfile(modelId: string, profileId: number): Promise<unknown>;
};
/** The supplied readers must query the current owned account, not cached history. */
export declare function resolveCompletedJobReference(taskId: string, serial: string, reads: ReferenceReads, currentMapping?: CurrentMapping): Promise<CompletedJobReference>;
/** Re-fetch immediately before final preflight and dispatch; caller owns live printer checks. */
export declare function revalidateCompletedJobReference(reference: CompletedJobReference, reads: ReferenceReads, currentMapping?: CurrentMapping): Promise<CompletedJobReference>;
export {};
