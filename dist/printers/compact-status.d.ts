/** Allowlisted monitoring data; missing telemetry stays null. Never use for print authorization. */
export declare function compactPrinterStatus(status: any, fresh: boolean): {
    detail: string;
    connected: boolean;
    state: string | null;
    model: string | null;
    freshness: string;
    observation: {
        source: string;
        requested_at: number;
        received_at: number;
        identity_source: string;
        identity_verified: boolean;
    } | null;
    progress: {
        percent: number | null;
        remaining_minutes: number | null;
        layer: number | null;
        total_layers: number | null;
    };
    temperatures: {
        nozzles: {
            index: number;
            position: "right" | "left";
            actual: number;
            target: number;
        }[];
        nozzle: {
            actual: number | null;
            target: number | null;
        };
        bed: {
            actual: number | null;
            target: number | null;
        };
        chamber: number | null;
    };
    slots: Record<string, unknown>[];
    slots_truncated: boolean;
    errors: {
        print_error: number | null;
        hms: any;
        hms_truncated: boolean;
    };
};
