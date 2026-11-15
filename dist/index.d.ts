#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
export declare class BambuPrinterMCPServer {
    private server;
    private bambu;
    private bambuNetwork;
    private readonly cad;
    private readonly blender;
    private readonly fusion;
    private readonly blenderSetup;
    private readonly fusionSetup;
    private stlManipulator;
    private readonly runtimeConfig;
    private httpRuntime?;
    private shuttingDown;
    private readonly confirmationTimeoutMs;
    constructor();
    /** Protocol peers share this owner's printer, camera, CAD and bridge resources. */
    private createProtocolServer;
    /** The running Blender add-on's get_addon_status, read through this server's Blender bridge (undefined when it has none). */
    private blenderAddonHandshake;
    /**
     * The model for display-only counterpart tools: the argument, then the
     * configured model, then the serial prefix. Never a safety decision and
     * never elicited; print routes use resolveBambuModel and fresh identity.
     */
    private displayModel;
    /**
     * Resolve the Bambu printer model from args, env, or by asking the user via elicitation.
     * This is critical for safety: the wrong model can cause physical damage to the printer.
     */
    private resolveBambuModel;
    private bridgeOptionsFromArgs;
    private resolveExecutableSelectorArg;
    private resolveSlicerConfigFromArgs;
    private ensurePrintableThreeMFPath;
    private resolveAmsPrintSettings;
    private print3mfViaBambuNetwork;
    private handoff3mfViaBambuConnect;
    private print3mfViaBambuNative;
    private uploadFileViaBambuNative;
    private getResolvedPrinterFilamentInventory;
    /**
     * `sliceArgs`: the slice_stl arguments a client would send with this file (slicer_profile, template_name,
     * template_3mf_path, layer_height, wall_loops, sparse_infill_density, quality, strength). `requestedTemplatePath`:
     * their template, resolved. own_process says whether that slice prints the process the 3MF carries, unchanged.
     */
    private inspectSliceSettings;
    private resolveCollarCharmPrepared3MF;
    private preflightCollarCharmPolicy;
    private listTemplateRegistry;
    private resolveTemplatePath;
    private saveTemplate;
    /** The FDM design guidance as MCP prompts: the client decides when to attach each one. */
    setupPromptHandlers(server: Server): void;
    setupResourceHandlers(server: Server): void;
    setupToolHandlers(server: Server): void;
    startStdio(): Promise<void>;
    shutdown(exitCode?: number): Promise<void>;
    startHttp(): Promise<void>;
    run(): Promise<void>;
}
