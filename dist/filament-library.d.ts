/** Read-only cloud catalogue and exact, evidence-preserving printer identity matching. */
export interface CloudFilamentSpool {
    id: string;
    filament_id: string | null;
    rfid: string | null;
    brand: string | null;
    material: string | null;
    name: string | null;
    color: string | null;
    colors: string[] | null;
    net_weight_g: number | null;
    total_net_weight_g: number | null;
    status: string | number | null;
    updated_at: number | string | null;
    reported_location: {
        source: 'account_report';
        freshness: 'not_guaranteed';
        in_printer: boolean | null;
        device_id: string | null;
        ams_serial: string | null;
        ams_id: number | null;
        ams_type: number | null;
        slot_id: string | null;
        device_name: string | null;
    } | null;
}
export interface CloudFilamentInventory {
    source: 'bambu_account_cloud';
    fetched_at: string;
    retrieval_complete: true;
    retrieval_mode: 'single_catalogue_response' | 'offset_pages';
    reported_total: number | null;
    consistency: 'not_guaranteed';
    spools: CloudFilamentSpool[];
}
export declare function canonicalSpoolRfid(v: unknown): string | null;
/** No partial results: page errors, changed totals, duplicates and unproven termination fail. */
export declare function readFilamentLibrary(request: (path: string, signal: AbortSignal) => Promise<Record<string, unknown>>, timeoutMs?: number, signal?: AbortSignal): Promise<CloudFilamentInventory>;
export type FilamentMatch = {
    status: 'matched';
    spool_id: string;
} | {
    status: 'unlinked' | 'ambiguous';
    spool_id: null;
};
/** A match requires a unique canonical cloud RFID and unique observed printer UUID. */
export declare function matchFilamentLibrary(spools: CloudFilamentSpool[], trays: Array<{
    tray_uuid?: unknown;
}>): FilamentMatch[];
/** The printer's reported slots are display telemetry and may be cached or incomplete. */
export interface InventoryTray {
    tray_uuid?: string | null;
    occupancy?: 'reported_loaded' | 'reported_empty' | 'unknown';
    loaded: boolean;
    source?: 'ams' | 'external';
    ams_id: number | null;
    tray_id: number | null;
    slot: number | null;
    label: string | null;
    physical_extruder?: {
        index: number;
        position: 'right' | 'left';
        role: 'main' | 'deputy';
    } | null;
    tray_info_idx: string | null;
    tray_type: string | null;
    tray_sub_brands: string | null;
    tray_color: string | null;
    remain_percent: number | null;
    nominal_weight_g?: number | null;
    remaining_weight_g?: number | null;
}
/** Combine only strong identity matches. Unmatched observations may overlap library reels. */
export declare function unifyFilamentInventory(library: CloudFilamentInventory | null, trays: InventoryTray[]): {
    spools: {
        load_state: "unknown" | "loaded" | "not_loaded";
        location: {
            source: "printer_report";
            freshness: "not_guaranteed";
            feed: "ams" | "external" | null;
            ams_id: number | null;
            tray_id: number | null;
            slot: number | null;
            label: string | null;
            physical_extruder: {
                index: number;
                position: "right" | "left";
                role: "main" | "deputy";
            } | null;
        } | {
            updated_at: string | number | null;
            fetched_at: string;
            source: "account_report";
            freshness: "not_guaranteed";
            in_printer: boolean | null;
            device_id: string | null;
            ams_serial: string | null;
            ams_id: number | null;
            ams_type: number | null;
            slot_id: string | null;
            device_name: string | null;
        } | null;
        load_state_evidence: "unknown" | "account_report" | "printer_uuid_match" | "ambiguous_identity";
        account_report: {
            updated_at: string | number | null;
            fetched_at: string;
            source: "account_report";
            freshness: "not_guaranteed";
            in_printer: boolean | null;
            device_id: string | null;
            ams_serial: string | null;
            ams_id: number | null;
            ams_type: number | null;
            slot_id: string | null;
            device_name: string | null;
        } | null;
        conflict: "account_reports_not_loaded" | "account_binding_differs" | null;
        quantities: {
            account: {
                net_weight_g: number | null;
                total_net_weight_g: number | null;
            };
            printer: {
                remaining_percent: number | null;
                remaining_weight_g: number | null;
                nominal_weight_g: number | null;
            } | null;
        };
        id: string;
        filament_id: string | null;
        rfid: string | null;
        brand: string | null;
        material: string | null;
        name: string | null;
        color: string | null;
        colors: string[] | null;
        net_weight_g: number | null;
        total_net_weight_g: number | null;
        status: string | number | null;
        updated_at: number | string | null;
        reported_location: {
            source: "account_report";
            freshness: "not_guaranteed";
            in_printer: boolean | null;
            device_id: string | null;
            ams_serial: string | null;
            ams_id: number | null;
            ams_type: number | null;
            slot_id: string | null;
            device_name: string | null;
        } | null;
        identity: {
            source: "account";
            id: string;
        };
    }[];
    unmatched_printer_spool_observations: {
        identity: {
            source: "printer_uuid";
            id: string;
        };
        id: null;
        filament_id: string | null;
        rfid: string | null;
        brand: null;
        material: string | null;
        name: string | null;
        name_source: "tray_sub_brands";
        color: string | null;
        colors: null;
        may_overlap_library_records: boolean;
        load_state: "loaded";
        location: {
            source: "printer_report";
            freshness: "not_guaranteed";
            feed: "ams" | "external" | null;
            ams_id: number | null;
            tray_id: number | null;
            slot: number | null;
            label: string | null;
            physical_extruder: {
                index: number;
                position: "right" | "left";
                role: "main" | "deputy";
            } | null;
        };
        load_state_evidence: "printer_report";
        account_report: null;
        conflict: null;
        quantities: {
            account: null;
            printer: {
                remaining_percent: number | null;
                remaining_weight_g: number | null;
                nominal_weight_g: number | null;
            };
        };
    }[];
    unidentified_loaded_slots: InventoryTray[];
    coverage: {
        library: "available" | "unavailable_or_not_requested";
        printer: "reported_slots_only";
        library_records: number | null;
        unmatched_printer_spool_observations: number;
        unidentified_loaded_slots: number;
        unknown_occupancy_slots: number;
        unique_physical_count: null;
    };
};
