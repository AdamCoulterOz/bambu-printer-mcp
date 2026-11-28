/**
 * Named printers one server can address. The printer configured by
 * BAMBU_PRINTER_HOST/SERIAL/ACCESS_TOKEN/MODEL stays the default; more come
 * from BAMBU_PRINTERS (inline JSON) or BAMBU_PRINTERS_FILE (a JSON file). A
 * tool call picks one with `printer` (name or serial), or names a registered
 * serial with `bambu_serial`; either fills that printer's host, access code,
 * model and route into the call's arguments.
 *
 * Configured values only route the call. They never replace the fresh
 * printer identity that print and control safety checks require.
 */
export interface ConfiguredPrinter {
    name: string;
    serial: string;
    host: string;
    token: string;
    model: string;
    connectionMode?: string;
    connectionType?: string;
    isDefault: boolean;
}
export interface DefaultPrinterConfig {
    name?: string;
    host: string;
    serial: string;
    token: string;
    model: string;
}
export declare function loadPrinterRegistry(env: NodeJS.ProcessEnv, defaults: DefaultPrinterConfig, validModels: readonly string[]): ConfiguredPrinter[];
export declare class PrinterSelectionError extends Error {
}
/**
 * Returns the call's arguments with the selected printer's routing filled in.
 * Values the caller passed explicitly are kept; a conflicting serial or model
 * is refused rather than silently mixing two printers.
 */
export declare function applyPrinterSelection(args: Record<string, unknown> | undefined, registry: ConfiguredPrinter[], accepted?: ReadonlySet<string>): Record<string, unknown> | undefined;
/** Public listing: never includes access codes. */
export declare function describePrinters(registry: ConfiguredPrinter[]): {
    connection_mode?: string | undefined;
    name: string;
    serial: string;
    model: string | null;
    host: string;
    default: boolean;
    access_code_configured: boolean;
}[];
export declare const PRINTER_ARGUMENT: {
    readonly type: "string";
    readonly description: "Which configured printer to use, by name or serial (see list_configured_printers). Defaults to the server's configured printer.";
};
/** Adds the `printer` choice to every tool that already targets a printer or model. */
export declare function withPrinterChoice<T extends {
    inputSchema?: {
        properties?: Record<string, unknown>;
    };
}>(tool: T): T;
