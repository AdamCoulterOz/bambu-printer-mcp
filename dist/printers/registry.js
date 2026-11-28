import fs from "node:fs";
const text = (value) => (typeof value === "string" ? value.trim() : "");
function readEntries(env) {
    const sources = [];
    const file = text(env.BAMBU_PRINTERS_FILE);
    if (file)
        sources.push({ label: "BAMBU_PRINTERS_FILE", json: fs.readFileSync(file, "utf8") });
    const inline = text(env.BAMBU_PRINTERS);
    if (inline)
        sources.push({ label: "BAMBU_PRINTERS", json: inline });
    const entries = [];
    for (const { label, json } of sources) {
        let parsed;
        try {
            parsed = JSON.parse(json);
        }
        catch {
            throw new Error(`${label} is not valid JSON.`);
        }
        const list = Array.isArray(parsed) ? parsed : parsed?.printers;
        if (!Array.isArray(list))
            throw new Error(`${label} must be a JSON array of printers or {"printers": [...]}.`);
        for (const item of list) {
            if (!item || typeof item !== "object" || Array.isArray(item))
                throw new Error(`${label} entries must be objects.`);
            entries.push(item);
        }
    }
    return entries;
}
function entryToken(entry, env, name) {
    if ("access_code" in entry || "bambu_token" in entry) {
        throw new Error(`Printer ${name}: put the access code in a file (access_code_file) or an environment variable (access_code_env), not in the printer list.`);
    }
    const file = text(entry.access_code_file);
    const envName = text(entry.access_code_env);
    if (file && envName)
        throw new Error(`Printer ${name}: set access_code_file or access_code_env, not both.`);
    if (file)
        return fs.readFileSync(file, "utf8").trim();
    if (envName)
        return text(env[envName]);
    return "";
}
export function loadPrinterRegistry(env, defaults, validModels) {
    const printers = [];
    if (defaults.serial.trim()) {
        const model = defaults.model.trim().toLowerCase();
        printers.push({
            name: text(defaults.name) || (model ? model.toUpperCase() : "default"),
            serial: defaults.serial.trim().toUpperCase(),
            host: defaults.host,
            token: defaults.token,
            model,
            isDefault: true,
        });
    }
    for (const entry of readEntries(env)) {
        const name = text(entry.name);
        const serial = text(entry.serial).toUpperCase();
        const host = text(entry.host);
        const model = text(entry.model).toLowerCase();
        if (!name || !serial || !host || !model)
            throw new Error("Each configured printer needs name, serial, host and model.");
        if (!validModels.includes(model))
            throw new Error(`Printer ${name}: unsupported model ${model}. Use one of: ${validModels.join(", ")}.`);
        const connectionMode = text(entry.connection_mode).toLowerCase() || undefined;
        const connectionType = text(entry.connection_type).toLowerCase() || undefined;
        printers.push({ name, serial, host, model, token: entryToken(entry, env, name), connectionMode, connectionType, isDefault: false });
    }
    const names = new Set();
    const serials = new Set();
    for (const printer of printers) {
        const key = printer.name.toLowerCase();
        if (names.has(key))
            throw new Error(`Two configured printers are named ${printer.name}.`);
        if (serials.has(printer.serial))
            throw new Error(`Printer serial ${printer.serial} is configured twice.`);
        names.add(key);
        serials.add(printer.serial);
    }
    return printers;
}
export class PrinterSelectionError extends Error {
}
function findPrinter(registry, wanted) {
    const key = wanted.trim().toLowerCase();
    return registry.find(p => p.name.toLowerCase() === key) ?? registry.find(p => p.serial.toLowerCase() === key);
}
/**
 * Returns the call's arguments with the selected printer's routing filled in.
 * Values the caller passed explicitly are kept; a conflicting serial or model
 * is refused rather than silently mixing two printers.
 */
export function applyPrinterSelection(args, registry, accepted) {
    if (!args)
        return args;
    const requested = args.printer;
    let printer;
    if (requested !== undefined) {
        if (typeof requested !== "string" || !requested.trim())
            throw new PrinterSelectionError("printer must be a configured printer name or serial.");
        printer = findPrinter(registry, requested);
        if (!printer) {
            const known = registry.map(p => p.name).join(", ") || "none";
            throw new PrinterSelectionError(`Unknown printer "${requested}". Configured printers: ${known}.`);
        }
    }
    else if (typeof args.bambu_serial === "string" && args.bambu_serial.trim()) {
        // A serial alone selects a registered non-default printer; the default keeps its existing behavior.
        const match = registry.find(p => p.serial === String(args.bambu_serial).trim().toUpperCase());
        if (match && !match.isDefault)
            printer = match;
    }
    if (!printer) {
        if (requested === undefined)
            return args;
        const { printer: _ignored, ...rest } = args;
        return rest;
    }
    const { printer: _ignored, ...rest } = args;
    const explicitSerial = text(rest.bambu_serial).toUpperCase();
    if (explicitSerial && explicitSerial !== printer.serial) {
        throw new PrinterSelectionError(`bambu_serial does not match printer ${printer.name}. Pass one or the other.`);
    }
    const explicitModel = text(rest.bambu_model).toLowerCase();
    if (explicitModel && printer.model && explicitModel !== printer.model) {
        throw new PrinterSelectionError(`bambu_model ${explicitModel} does not match printer ${printer.name} (${printer.model}).`);
    }
    // Only the routing arguments the tool declares are filled, so a file-only tool gets just the model.
    const out = { ...rest };
    const fill = (key, value) => {
        if (value === undefined || text(rest[key]) || (accepted && !accepted.has(key)))
            return;
        out[key] = value;
    };
    fill("bambu_serial", printer.serial);
    fill("host", printer.host);
    fill("bambu_token", printer.token);
    if (printer.model)
        fill("bambu_model", printer.model);
    if (!printer.isDefault) {
        // The server-wide default route was chosen for the default printer. Another
        // printer uses its own configured route, else the per-model default.
        fill("connection_mode", printer.connectionMode ?? (printer.model === "x2d" ? "bambu_native" : "lan_mqtt_ftps"));
        fill("connection_type", printer.connectionType);
        fill("dev_id", printer.serial);
    }
    return out;
}
/** Public listing: never includes access codes. */
export function describePrinters(registry) {
    return registry.map(p => ({
        name: p.name,
        serial: p.serial,
        model: p.model || null,
        host: p.host,
        default: p.isDefault,
        access_code_configured: Boolean(p.token),
        ...(p.connectionMode ? { connection_mode: p.connectionMode } : {}),
    }));
}
export const PRINTER_ARGUMENT = {
    type: "string",
    description: "Which configured printer to use, by name or serial (see list_configured_printers). Defaults to the server's configured printer.",
};
/** Adds the `printer` choice to every tool that already targets a printer or model. */
export function withPrinterChoice(tool) {
    const properties = tool.inputSchema?.properties;
    if (!properties || !("bambu_serial" in properties || "bambu_model" in properties) || "printer" in properties)
        return tool;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, printer: PRINTER_ARGUMENT } } };
}
