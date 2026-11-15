/** Static agent guidance and a local-only readiness summary. This module does no I/O. */
export const AGENT_WORKFLOW_URI = "bambu://workflow/printing";
export const AGENT_WORKFLOW_INSTRUCTIONS = ` Call get_agent_guide for the task index, or read bambu://workflow/index, then discover tools and their input schemas with tools/list. For printing, use get_agent_guide with topic printing or read ${AGENT_WORKFLOW_URI}, and call get_agent_readiness. This reports local configuration only; fresh printer safety checks and the person's print request remain necessary.`;
export const AGENT_WORKFLOW_RESOURCE = {
    uri: AGENT_WORKFLOW_URI,
    name: "Agent printing workflow",
    description: "How to prepare, inspect, authorize, dispatch, and monitor a print using this server.",
    mimeType: "text/plain",
};
export const AGENT_WORKFLOW_TEXT = `Printing workflow

1. Identify the intended printer and verify its model, nozzle configuration, bed and current AMS inventory. Use counterpart_setup_fields for setup and counterpart_printer_info for configured capabilities; get_printer_status and get_printer_filaments supply observed printer information. Do not guess the model or treat configured identity as live evidence.
2. Prepare the requested artifact for that exact printer. A pre-sliced file does not need a local slicer. Use slice_stl and the installed matching model/nozzle presets when slicing is needed. For offline slicer CLI exports, --min-save concerns the SLICED export format with plate G-code; it does not resolve incomplete profiles. An unsliced geometry 3MF is not a printable export. Preserve the intended project and selected plate; do not resume or reslice an unexpected file.
3. Use list_3mf_plates and inspect_print_file for the exact file and selected plate. Check its semantic metadata, including plate metadata, machine, nozzles, materials and bed, and the computed artifact/G-code hash as applicable. For dual-nozzle jobs compose the selected plate's filament mapping with physical extruder mapping and the current physical AMS/external-tray assignments. File-only inspection is not authorization and does not establish live printer safety or physical spool contents.
4. Check fresh observed printer identity, nozzle configuration, state and actionable errors. The existing print tool independently checks its final immutable file snapshot, selected plate, temperatures, material mapping and fresh printer safety evidence. Follow its refusals and any specific existing elicitation requirements. Local readiness and successful file inspection cannot replace these gates.
5. Consult the selected print tool's input schema for the model and required options. Act on the person's request to print; ordinary print starts do not require an extra MCP prompt. Dispatch the exact checked file once. If dispatch is ambiguous, check fresh printer status and the device job before any retry; never automatically fall back to another route or replay.
6. Monitor the fresh device job and report dispatch, actual running, first layer and completion as distinct observations. A publisher acknowledgement or helper receipt is not physical print success.

X2D native printing uses a native helper and plug-in to store jobs on a ready SD card or USB stick, otherwise internal eMMC. Signed MQTT controls are separate from native file upload and printing; signing does not upload a file. Local helper or plug-in availability does not prove ABI compatibility, an authenticated session or device acceptance. Readiness below is configuration/capability evidence only, not live or physical readiness.`;
/** Discoverable task guides. Tool schemas, not this index, define arguments and availability. */
const taskGuides = [
    ["setup", "Setup and connection", `For parallel MCP clients, one private stateful HTTP server shares a backend; each client owns a separate protocol session. Configure HTTP supervision and the MCP client outside MCP. Use loopback and a private bearer token file; stdio-only clients can use bambu-printer-mcp-http-client with BAMBU_MCP_HTTP_URL and BAMBU_MCP_HTTP_TOKEN_FILE. That relay starts no printer backend and never automatically replays requests. MCP_HTTP_STATEFUL=false is unsupported. See docs/SETUP.md for transport settings. Choose a compatible route before changing printer modes and preserve the person’s cloud and Bambu Handy preference. LAN Only disconnects cloud; legacy unsigned LAN, signed local/cloud and native routes have different model- and firmware-specific prerequisites and support is not universal. Use get_agent_readiness for local prerequisites, counterpart_setup_fields for settings, counterpart_self_check for the installed runtime, and counterpart_discover_printers for LAN discovery. counterpart_printer_info reports configured model capabilities; verify identity and use get_printer_status for observed state. Setup still requires installing the server and configuring an MCP client outside the connection. Avoid returning credentials.`],
    ["signing", "Optional signed MQTT controls", `Signed controls are opt-in, and support varies by model, route and firmware. Preserve the person’s cloud and Bambu Handy preference; do not switch to LAN Only automatically for signed local or cloud setup. They are independent of native SDK/FULU sessions and file transfer. To configure, set BAMBU_SIGNED_CONTROLS=true, choose BAMBU_SIGNED_WRITE_TRANSPORT=local or cloud, and supply absolute BAMBU_SIGNING_DIR, BAMBU_SIGNING_DEVICE_CA_FILE and BAMBU_SIGNING_STATE_DIR. The operator must supply slicer_key.pem, slicer_cert.pem and slicer_crl.pem in the signing directory; the private key must be owned and private. App credentials require the complete certificate chain, direct fixed application CA pin and a fresh CRL. Device trust uses the separately supplied device CA, not the app CA. OpenSSL 3 and a POSIX C compiler are prerequisites. Initialize a private durable sequence directory explicitly with bambu-printer-mcp-signing-setup <absolute-private-state-directory>; the optional --last-used-sequence value is for known prior history. To rebuild a missing helper without resetting state use bambu-printer-mcp-signing-setup --repair <existing-private-state-directory>. Preserve and recover the counter rather than resetting it. Reservations coordinate only processes sharing that directory, not Studio, Home Assistant or other hosts.

Local uses the printer host and LAN access code; optional BAMBU_SIGNED_LOCAL_TLS_CA_FILE and BAMBU_SIGNED_LOCAL_TLS_SERVERNAME configure broker TLS trust and DNS name, separate from device attestation CA trust. Cloud uses BAMBU_SIGNED_CLOUD_BROKER, BAMBU_SIGNED_CLOUD_USERNAME and BAMBU_SIGNED_CLOUD_TOKEN together, or BAMBU_SIGNED_CLOUD_AUTH=account; complete explicit credentials win and partial explicit credentials fail. See the account guide. An account session is not the application PEM signing bundle. Selected signing fails closed when prerequisites or validation fail; do not fall back to plaintext or replay an ambiguous dispatch. Signing does not upload files. Supported project_file commands use signed dispatch; gcode_file routes are blocked when signing is selected. The typed LED command uses its own deterministic unsigned protocol route, not a fallback after signing fails. Raw bridge access remains subject to its read-only allowlist. These are source-level capabilities; configuration, successful setup or a local check does not prove a live session or printer acceptance.`],
    ["account", "Optional Bambu account", `The optional account manager is inert until invoked. account_status reads cached local state; ready does not establish live authentication. account_login takes only region (global or china) and returns a short-lived loopback browser URL and expiry. Open it on the server host, or use an SSH local forward to the same port for a remote host; do not expose the listener publicly. Enter passwords and email verification or authenticator codes only in that browser, never in chat, MCP arguments or elicitation. The flow contacts the region's Bambu HTTPS service; a code is resent only when the person clicks the relevant control. account_cancel_login closes the flow. account_list_printers contacts the live API and returns bound printer names, models and serials, not access codes. account_logout removes the local session but does not revoke the remote session. No refresh API is claimed. For signed cloud MQTT, BAMBU_SIGNED_CLOUD_AUTH=account opts into this session; complete explicit broker, username and token take precedence, and partial explicit credentials fail instead of mixing sources. The server verifies the selected serial is bound before using the account session for cloud MQTT. An account token is not the application PEM signing bundle; this login does not establish native helper or FULU sessions and signing does not upload files.`],
    ["status", "Models, status and materials", `counterpart_printer_info describes model capabilities. get_printer_status normally returns display state, which may be cached and has no safety freshness guarantee. Use get_printer_status with fresh:true to request new MQTT state/error telemetry plus a matching printer-returned observedSerial, observed model and observation timestamps; missing identity or conflicting serials fail. Fresh identity telemetry does not authorize dispatch or replace complete print preflight; get_printer_filaments reports available AMS materials. counterpart_propose_filaments and resolve_3mf_ams_slots help map the selected file's filament positions to live physical trays. Use actual model-specific support and fresh observed identity; configured settings alone do not prove the printer's state. printer://{host}/status and printer://{host}/hms are available status resources.`],
    ["camera", "Camera and visual evidence", `camera_snapshot captures an image. camera_stream_start, camera_frame and camera_stream_stop manage a shared stream when supported by the model. counterpart_print_record and counterpart_print_assess record and assess print evidence. Camera availability depends on model, network and runtime; an unclear image is not evidence of a clear plate or successful deposition.`],
    ["design", "Design and model editing", `Use list_templates and save_template for templates; get_stl_info, extend_stl_base, scale_stl, rotate_stl, merge_vertices, center_model and lay_flat for mesh operations. counterpart_make_3mf creates projects. cad_status, cad_setup, cad_examples, cad_run and cad_check_fit support the optional CAD engine when listed. Blender workflows use blender_mcp_status, blender_mcp_setup, blender_mcp_call and blender_mcp_edit_model; Fusion uses fusion_mcp_status, fusion_mcp_setup, fusion_mcp_call, fusion_mcp_new_design and fusion_mcp_export. Discover their schemas and output requirements first. Apply relevant FDM prompts or design_guidance and read guidance://fdm/capability-guidance and guidance://fdm/fit-by-function when applicable. Editing is not print validation.`],
    ["slicing", "Slicing and inspection", `list_3mf_plates and list_3mf_plate_objects explain projects; get_slice_settings reads supplied project or profile process settings. For supported Bambu-compatible slicers, slice_stl and slice_with_template use the MCP profile resolver with the selected installation's exact model/nozzle machine preset and recursively resolve inheritance and includes; missing or malformed dependencies stop preparation. Pass the exact model, nozzle, project and filament choices through the tool schema. print_3mf uses the same preparation when it needs to auto-slice. Rely on these checks within their documented scope for supported slicing. Do not replace this with raw vendor JSON CLI overlays, transplanted GUI labels, hand-patched startup code or trimmed multi-variant arrays. slice_stl returns the output path and, when available, the slicer's result and warnings; inspect_print_file checks the selected artifact and returns file-only evidence and artifact SHA-256. Neither exposes a complete materialized machine/process/filament provenance receipt, all variant/extruder relations, or proof that every expected vendor start/end, layer, AMS change and timelapse macro is present. If the person requests an independent full provenance or macro audit, say that it cannot currently be established through these MCP tools and escalate that stronger audit; do not claim it was performed. Model/nozzle comments, filenames, GUI previews and a successful slice alone do not prove complete configuration. --min-save is an export-format option, not a profile-resolution repair. For printer, plate, nozzle, materials and physical AMS mapping read bambu://workflow/printing. File-only inspection is not authorization.`],
    ["dispatch", "Transfer, print and monitoring", `Read bambu://workflow/printing before starting. list_printer_files, upload_gcode and upload_file offer supported file transfers; start_print, start_print_job, print_3mf and print_collar_charm are print entry points subject to their individual schemas and safety gates. counterpart_print_route selects a route; bambu_connect_import_file opens a file in Bambu Connect. The optional BambuNetwork path uses bambu_network_bridge_status, bambu_network_call and print_3mf_bambu_network. counterpart_print_progress and counterpart_print_record monitor observed jobs. Model and transport support differ: X2D native printing stores files on ready SD/USB or internal eMMC; signed MQTT controls do not upload files. Neither a command receipt nor helper availability proves device acceptance or a physical print. Never replay an ambiguous dispatch automatically.`],
    ["controls", "Controls and maintenance", `pause_print, resume_print, cancel_print and skip_objects operate on jobs; set_print_speed, set_airduct_mode, set_temperature, set_fan_speed, set_light and set_ams_drying adjust settings; reread_ams_rfid refreshes filament metadata. delete_printer_file removes a file; clear_hms_errors clears errors and has specific human-confirmation and recheck requirements. x2d_native_control covers only its explicitly supported X2D settings; arbitrary native or raw commands are unsupported. bambu_network_call is limited to the six read-only methods bridge.handshake, net.is_user_login, net.get_user_id, net.get_user_name, net.get_user_avatar and net.get_user_nickanme (agent initialization can have local side effects). Raw bridge mutations are refused. Selected signed mode does not permit a raw bypass; never replay an ambiguous command. Follow each listed schema and model restrictions, act within the person's intent, and preserve existing safety and elicitation gates. Stop and heater-off remain available.`],
];
export const AGENT_GUIDE_INDEX_URI = "bambu://workflow/index";
const indexText = `Agent task index\n\nUse get_agent_guide with a topic to read these same guides without resources. Use tools/list to discover the current tool names, input and output schemas and annotations. Read the relevant task resource below, then choose the tool appropriate to the person's request. Tool availability may vary with server configuration, platform and printer model. Check returned evidence and errors; do not infer physical outcomes from local configuration.\n\n${taskGuides.map(([slug, title]) => `${title}: bambu://workflow/${slug}`).join("\n")}\nPrinting sequence: ${AGENT_WORKFLOW_URI}\nExisting FDM guidance: guidance://fdm/capability-guidance and guidance://fdm/fit-by-function; use prompts or design_guidance for the other design topics.`;
export const AGENT_GUIDE_RESOURCES = [
    { uri: AGENT_GUIDE_INDEX_URI, name: "Agent task index", description: "Discover task guides and existing tools.", mimeType: "text/plain" },
    ...taskGuides.map(([slug, title]) => ({ uri: `bambu://workflow/${slug}`, name: title, description: `Agent guide: ${title.toLowerCase()}.`, mimeType: "text/plain" })),
];
export function getAgentGuideResource(uri) {
    if (uri === AGENT_GUIDE_INDEX_URI)
        return indexText;
    return taskGuides.find(([slug]) => uri === `bambu://workflow/${slug}`)?.[2];
}
/** Optional settings only: metadata, never configured values or credential contents. */
const signingFields = [
    { env: "BAMBU_SIGNED_CONTROLS", label: "Enable signed controls", required: false, hint: "Set true to opt in; unset or false disables signed controls.", choices: [{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }] },
    { env: "BAMBU_SIGNED_WRITE_TRANSPORT", label: "Signed control transport", required: false, hint: "Choose local or cloud when enabled.", choices: [{ value: "local", label: "Local" }, { value: "cloud", label: "Cloud" }] },
    { env: "BAMBU_SIGNING_DIR", label: "Application signing bundle directory", required: false, input: "path", hint: "Absolute directory containing operator-provided slicer key, certificate chain and current CRL." },
    { env: "BAMBU_SIGNING_DEVICE_CA_FILE", label: "Device trust CA", required: false, input: "path", hint: "Absolute independent device attestation CA file, separate from the application CA and TLS broker trust." },
    { env: "BAMBU_SIGNING_STATE_DIR", label: "Signing counter directory", required: false, input: "path", hint: "Absolute private durable directory initialized by bambu-printer-mcp-signing-setup; preserve existing counter state." },
    { env: "BAMBU_SIGNED_LOCAL_TLS_CA_FILE", label: "Local broker TLS CA", required: false, input: "path", hint: "Optional absolute TLS CA for the local broker; distinct from the device attestation CA." },
    { env: "BAMBU_SIGNED_LOCAL_TLS_SERVERNAME", label: "Local broker TLS server name", required: false, hint: "Optional DNS name for local broker TLS verification." },
    { env: "BAMBU_SIGNED_CLOUD_BROKER", label: "Cloud MQTT broker", required: false, hint: "Supply with cloud username and token, or choose account authentication." },
    { env: "BAMBU_SIGNED_CLOUD_USERNAME", label: "Cloud MQTT username", required: false, hint: "Supply with the broker and token." },
    { env: "BAMBU_SIGNED_CLOUD_TOKEN", label: "Cloud MQTT token", required: false, input: "secret", hint: "Store privately; supply with the broker and username." },
    { env: "BAMBU_SIGNED_CLOUD_AUTH", label: "Cloud account authentication", required: false, hint: "Set account to use the optional cached account session when no explicit cloud credentials are supplied.", choices: [{ value: "account", label: "Bambu account" }] },
];
/** Tool and resources share exactly the same guide text. */
export const AGENT_GUIDE_TOPICS = ["index", "setup", "status", "camera", "design", "slicing", "dispatch", "controls", "account", "signing", "printing"];
export function getAgentGuide(topic = "index") {
    if (typeof topic !== "string" || !AGENT_GUIDE_TOPICS.some(item => item === topic))
        throw new Error("Unknown agent guide topic.");
    const uri = `bambu://workflow/${topic}`;
    const text = topic === "printing" ? AGENT_WORKFLOW_TEXT : getAgentGuideResource(uri);
    if (text === undefined)
        throw new Error("Agent guide is unavailable.");
    return { topic, uri, text, available_topics: [...AGENT_GUIDE_TOPICS], ...(topic === "signing" ? { configuration_fields: signingFields } : {}) };
}
export const AGENT_GUIDE_TOOL = {
    name: "get_agent_guide",
    description: "Read the task index or a focused agent guide without MCP resource or prompt support. Static guidance only; consult tools/list for current schemas and availability.",
    inputSchema: { type: "object", properties: { topic: { type: "string", enum: AGENT_GUIDE_TOPICS, description: "Guide topic; defaults to index." } }, additionalProperties: false },
    outputSchema: {
        type: "object",
        properties: { topic: { type: "string", enum: AGENT_GUIDE_TOPICS }, uri: { type: "string" }, text: { type: "string" }, configuration_fields: { type: "array", items: { type: "object", properties: { env: { type: "string" }, label: { type: "string" }, required: { type: "boolean", const: false }, input: { type: "string", enum: ["path", "secret"] }, hint: { type: "string" }, choices: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } }, required: ["value", "label"] } } }, required: ["env", "label", "required", "hint"], additionalProperties: false } }, available_topics: { type: "array", items: { type: "string", enum: AGENT_GUIDE_TOPICS } } },
        required: ["topic", "uri", "text", "available_topics"], additionalProperties: false,
    },
};
export const AGENT_WORKFLOW_PROMPT = {
    name: "printing_workflow",
    title: "Printing workflow",
    description: "Prepare, inspect, dispatch and monitor the person's requested print.",
    text: AGENT_WORKFLOW_TEXT,
};
const state = (value) => value === true ? "available" : value === false ? "missing" : "unknown";
export function getAgentReadiness(context) {
    const prerequisites = [
        { code: "printer_host", state: state(context.printerHostConfigured), action: "Configure or supply the printer host for the chosen call." },
        { code: "printer_serial", state: state(context.printerSerialConfigured), action: "Configure or supply the printer serial for the chosen call." },
        { code: "printer_token", state: state(context.printerTokenConfigured), action: "Configure or supply the LAN access code privately for the chosen call." },
        { code: "printer_model", state: state(context.printerModelConfigured), action: "Configure or explicitly supply the verified printer model." },
    ];
    return {
        scope: "local_configuration",
        dispatch_authorized: false,
        physical_readiness_checked: false,
        prerequisites: prerequisites.map(({ code, state }) => ({ code, state })),
        blockers: [...prerequisites.filter(item => item.state !== "available").map(({ code, state, action }) => ({ code, state, next_action: action })), ...(context.signedControlsSelected === true && context.signedConfigurationValid === false ? [{ code: "signed_configuration", state: "missing", next_action: "Read the signing guide and correct the selected signing configuration." }] : [])],
        signed_controls: { selected: context.signedControlsSelected === true ? "selected" : context.signedControlsSelected === false ? "not_selected" : "unknown", configuration: state(context.signedConfigurationValid) },
        capabilities: {
            slicer: state(context.slicerConfigured),
            native_print: state(context.nativePrintAvailable),
            signed_mqtt: state(context.signedMqttAvailable),
        },
        next_actions: ["Read bambu://workflow/printing and use counterpart_setup_fields for setup.", "Inspect the exact file and obtain fresh printer status before the existing print safety checks."],
        limitations: "Configuration only; per-call settings may satisfy prerequisites. Slicing is optional for pre-sliced files. Native helper or signing availability does not prove a session, device acceptance, or physical readiness.",
    };
}
const stateSchema = { type: "string", enum: ["available", "missing", "unknown"] };
export const AGENT_READINESS_TOOL = {
    name: "get_agent_readiness",
    description: "Summarize known local configuration and capability prerequisites without contacting a printer or exposing configured values. This does not authorize dispatch or establish live or physical readiness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
        type: "object",
        properties: {
            scope: { type: "string", const: "local_configuration" },
            dispatch_authorized: { type: "boolean", const: false },
            physical_readiness_checked: { type: "boolean", const: false },
            prerequisites: { type: "array", items: { type: "object", properties: { code: { type: "string" }, state: stateSchema }, required: ["code", "state"], additionalProperties: false } },
            blockers: { type: "array", items: { type: "object", properties: { code: { type: "string" }, state: stateSchema, next_action: { type: "string" } }, required: ["code", "state", "next_action"], additionalProperties: false } },
            signed_controls: { type: "object", properties: { selected: { type: "string", enum: ["selected", "not_selected", "unknown"] }, configuration: stateSchema }, required: ["selected", "configuration"], additionalProperties: false },
            capabilities: { type: "object", properties: { slicer: stateSchema, native_print: stateSchema, signed_mqtt: stateSchema }, required: ["slicer", "native_print", "signed_mqtt"], additionalProperties: false },
            next_actions: { type: "array", items: { type: "string" } },
            limitations: { type: "string" },
        },
        required: ["scope", "dispatch_authorized", "physical_readiness_checked", "prerequisites", "blockers", "signed_controls", "capabilities", "next_actions", "limitations"],
        additionalProperties: false,
    },
};
