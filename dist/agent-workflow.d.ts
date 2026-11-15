/** Static agent guidance and a local-only readiness summary. This module does no I/O. */
export declare const AGENT_WORKFLOW_URI = "bambu://workflow/printing";
export declare const AGENT_WORKFLOW_INSTRUCTIONS = " Call get_agent_guide for the task index, or read bambu://workflow/index, then discover tools and their input schemas with tools/list. For printing, use get_agent_guide with topic printing or read bambu://workflow/printing, and call get_agent_readiness. This reports local configuration only; fresh printer safety checks and the person's print request remain necessary.";
export declare const AGENT_WORKFLOW_RESOURCE: {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
};
export declare const AGENT_WORKFLOW_TEXT = "Printing workflow\n\n1. Identify the intended printer and verify its model, nozzle configuration, bed and current AMS inventory. Use counterpart_setup_fields for setup and counterpart_printer_info for configured capabilities; get_printer_status and get_printer_filaments supply observed printer information. Do not guess the model or treat configured identity as live evidence.\n2. Prepare the requested artifact for that exact printer. A pre-sliced file does not need a local slicer. Use slice_stl and the installed matching model/nozzle presets when slicing is needed. For offline slicer CLI exports, --min-save concerns the SLICED export format with plate G-code; it does not resolve incomplete profiles. An unsliced geometry 3MF is not a printable export. Preserve the intended project and selected plate; do not resume or reslice an unexpected file.\n3. Use list_3mf_plates and inspect_print_file for the exact file and selected plate. Check its semantic metadata, including plate metadata, machine, nozzles, materials and bed, and the computed artifact/G-code hash as applicable. For dual-nozzle jobs compose the selected plate's filament mapping with physical extruder mapping and the current physical AMS/external-tray assignments. File-only inspection is not authorization and does not establish live printer safety or physical spool contents.\n4. Check fresh observed printer identity, nozzle configuration, state and actionable errors. The existing print tool independently checks its final immutable file snapshot, selected plate, temperatures, material mapping and fresh printer safety evidence. Follow its refusals and any specific existing elicitation requirements. Local readiness and successful file inspection cannot replace these gates.\n5. Consult the selected print tool's input schema for the model and required options. Act on the person's request to print; ordinary print starts do not require an extra MCP prompt. Dispatch the exact checked file once. If dispatch is ambiguous, check fresh printer status and the device job before any retry; never automatically fall back to another route or replay.\n6. Monitor the fresh device job and report dispatch, actual running, first layer and completion as distinct observations. A publisher acknowledgement or helper receipt is not physical print success.\n\nX2D native printing uses a native helper and plug-in to store jobs on a ready SD card or USB stick, otherwise internal eMMC. Signed MQTT controls are separate from native file upload and printing; signing does not upload a file. Local helper or plug-in availability does not prove ABI compatibility, an authenticated session or device acceptance. Readiness below is configuration/capability evidence only, not live or physical readiness.";
export declare const AGENT_GUIDE_INDEX_URI = "bambu://workflow/index";
export declare const AGENT_GUIDE_RESOURCES: {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
}[];
export declare function getAgentGuideResource(uri: string): string | undefined;
type SigningSetupField = {
    env: string;
    label: string;
    required: false;
    input?: "path" | "secret";
    hint: string;
    choices?: Array<{
        value: string;
        label: string;
    }>;
};
/** Tool and resources share exactly the same guide text. */
export declare const AGENT_GUIDE_TOPICS: readonly ["index", "setup", "status", "camera", "design", "slicing", "dispatch", "controls", "account", "signing", "printing"];
export type AgentGuideTopic = typeof AGENT_GUIDE_TOPICS[number];
export declare function getAgentGuide(topic?: unknown): {
    configuration_fields?: SigningSetupField[] | undefined;
    topic: string;
    uri: string;
    text: string;
    available_topics: ("index" | "setup" | "signing" | "account" | "status" | "camera" | "design" | "slicing" | "dispatch" | "controls" | "printing")[];
};
export declare const AGENT_GUIDE_TOOL: {
    readonly name: "get_agent_guide";
    readonly description: "Read the task index or a focused agent guide without MCP resource or prompt support. Static guidance only; consult tools/list for current schemas and availability.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly topic: {
                readonly type: "string";
                readonly enum: readonly ["index", "setup", "status", "camera", "design", "slicing", "dispatch", "controls", "account", "signing", "printing"];
                readonly description: "Guide topic; defaults to index.";
            };
        };
        readonly additionalProperties: false;
    };
    readonly outputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly topic: {
                readonly type: "string";
                readonly enum: readonly ["index", "setup", "status", "camera", "design", "slicing", "dispatch", "controls", "account", "signing", "printing"];
            };
            readonly uri: {
                readonly type: "string";
            };
            readonly text: {
                readonly type: "string";
            };
            readonly configuration_fields: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly env: {
                            readonly type: "string";
                        };
                        readonly label: {
                            readonly type: "string";
                        };
                        readonly required: {
                            readonly type: "boolean";
                            readonly const: false;
                        };
                        readonly input: {
                            readonly type: "string";
                            readonly enum: readonly ["path", "secret"];
                        };
                        readonly hint: {
                            readonly type: "string";
                        };
                        readonly choices: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly value: {
                                        readonly type: "string";
                                    };
                                    readonly label: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["value", "label"];
                            };
                        };
                    };
                    readonly required: readonly ["env", "label", "required", "hint"];
                    readonly additionalProperties: false;
                };
            };
            readonly available_topics: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly enum: readonly ["index", "setup", "status", "camera", "design", "slicing", "dispatch", "controls", "account", "signing", "printing"];
                };
            };
        };
        readonly required: readonly ["topic", "uri", "text", "available_topics"];
        readonly additionalProperties: false;
    };
};
export declare const AGENT_WORKFLOW_PROMPT: {
    name: string;
    title: string;
    description: string;
    text: string;
};
/** Values are provided by the caller; undefined means not known. Never pass credentials or paths. */
export interface AgentReadinessContext {
    printerHostConfigured?: boolean;
    printerSerialConfigured?: boolean;
    printerTokenConfigured?: boolean;
    printerModelConfigured?: boolean;
    slicerConfigured?: boolean;
    nativePrintAvailable?: boolean;
    signedMqttAvailable?: boolean;
    signedControlsSelected?: boolean;
    signedConfigurationValid?: boolean;
}
type State = "available" | "missing" | "unknown";
export declare function getAgentReadiness(context: AgentReadinessContext): {
    scope: "local_configuration";
    dispatch_authorized: false;
    physical_readiness_checked: false;
    prerequisites: {
        code: string;
        state: State;
    }[];
    blockers: {
        code: string;
        state: State;
        next_action: string;
    }[];
    signed_controls: {
        selected: "unknown" | "selected" | "not_selected";
        configuration: State;
    };
    capabilities: {
        slicer: State;
        native_print: State;
        signed_mqtt: State;
    };
    next_actions: string[];
    limitations: string;
};
export declare const AGENT_READINESS_TOOL: {
    readonly name: "get_agent_readiness";
    readonly description: "Summarize known local configuration and capability prerequisites without contacting a printer or exposing configured values. This does not authorize dispatch or establish live or physical readiness.";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {};
        readonly additionalProperties: false;
    };
    readonly outputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly scope: {
                readonly type: "string";
                readonly const: "local_configuration";
            };
            readonly dispatch_authorized: {
                readonly type: "boolean";
                readonly const: false;
            };
            readonly physical_readiness_checked: {
                readonly type: "boolean";
                readonly const: false;
            };
            readonly prerequisites: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly code: {
                            readonly type: "string";
                        };
                        readonly state: {
                            type: string;
                            enum: string[];
                        };
                    };
                    readonly required: readonly ["code", "state"];
                    readonly additionalProperties: false;
                };
            };
            readonly blockers: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly code: {
                            readonly type: "string";
                        };
                        readonly state: {
                            type: string;
                            enum: string[];
                        };
                        readonly next_action: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["code", "state", "next_action"];
                    readonly additionalProperties: false;
                };
            };
            readonly signed_controls: {
                readonly type: "object";
                readonly properties: {
                    readonly selected: {
                        readonly type: "string";
                        readonly enum: readonly ["selected", "not_selected", "unknown"];
                    };
                    readonly configuration: {
                        type: string;
                        enum: string[];
                    };
                };
                readonly required: readonly ["selected", "configuration"];
                readonly additionalProperties: false;
            };
            readonly capabilities: {
                readonly type: "object";
                readonly properties: {
                    readonly slicer: {
                        type: string;
                        enum: string[];
                    };
                    readonly native_print: {
                        type: string;
                        enum: string[];
                    };
                    readonly signed_mqtt: {
                        type: string;
                        enum: string[];
                    };
                };
                readonly required: readonly ["slicer", "native_print", "signed_mqtt"];
                readonly additionalProperties: false;
            };
            readonly next_actions: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly limitations: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["scope", "dispatch_authorized", "physical_readiness_checked", "prerequisites", "blockers", "signed_controls", "capabilities", "next_actions", "limitations"];
        readonly additionalProperties: false;
    };
};
export {};
