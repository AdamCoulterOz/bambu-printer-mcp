import { validatePrinterState } from '../safety/printer-state.js';
import { normalizeMaterial, normalizeModel } from '../safety/limits.js';
import { resolveCompletedJobReference, revalidateCompletedJobReference } from './reprint.js';
export class ReferenceDispatchUnknown extends Error {
    constructor(reference) {
        super('Cloud reprint dispatch outcome is uncertain; inspect printer and history before retrying.');
        this.receipt = { sourceTaskId: reference.sourceTaskId, fingerprint: reference.fingerprint, verification: reference.verification, mappingSource: reference.declared.mappingSource, dispatch: 'unknown' };
    }
}
/** Preserve original one-based project filament IDs as zero-based global positions. */
export function referenceRequirements(reference) {
    const declared = reference.declared, model = normalizeModel(declared.deviceModel);
    if (!model || !reference.payload.amsMapping)
        throw new Error('requires_original_file');
    const size = Math.max(...declared.materials.map(m => m.id));
    const materials = Array(size).fill(''), filamentNozzleIndices = Array(size).fill(-1), usedFilamentPositions = [];
    declared.materials.forEach(m => { const p = m.id - 1, nozzle = m.nozzle; if (p < 0 || p >= size || !normalizeMaterial(m.type) || !Number.isInteger(nozzle) || nozzle < 0 || nozzle >= declared.nozzleDiameters.length || reference.payload.amsMapping[p] === undefined)
        throw new Error('requires_original_file'); materials[p] = m.type; filamentNozzleIndices[p] = nozzle; usedFilamentPositions.push(p); });
    const usedNozzleIndices = [...new Set(declared.materials.map(m => m.nozzle))].sort((a, b) => a - b);
    return { model, nozzleDiameters: usedNozzleIndices.map(i => declared.nozzleDiameters[i]), usedNozzleIndices, materials, usedFilamentPositions, filamentNozzleIndices, amsMapping: [...reference.payload.amsMapping], useAMS: reference.payload.useAms };
}
/** Fresh telemetry must report a material, not merely fail to contradict it. */
function requireKnownMaterials(status, requirements) {
    const validated = validatePrinterState(status, requirements), raw = status.raw;
    for (const entry of validated.filaments) {
        const index = entry.trayIndex;
        let unit;
        const tray = index >= 254
            ? (Array.isArray(raw.vir_slot) ? (() => { const matches = raw.vir_slot.filter((x) => Number(x?.id) === index); if (matches.length !== 1)
                throw new Error('Fresh external spool report is missing or ambiguous.'); return matches[0]; })() : raw.vt_tray)
            : (() => { const unitId = index >= 128 ? index : Math.floor(index / 4), slot = index >= 128 ? 0 : index % 4; const units = Array.isArray(raw.ams?.ams) ? raw.ams.ams.filter((x) => Number(x?.id) === unitId) : []; if (units.length !== 1)
                throw new Error('Fresh AMS unit report is missing or ambiguous.'); unit = units[0]; const trays = Array.isArray(unit?.tray) ? unit.tray.filter((x) => Number(x?.id) === slot) : []; if (trays.length !== 1)
                throw new Error('Fresh AMS tray report is missing or ambiguous.'); return trays[0]; })();
        const state = tray?.state;
        if (state !== undefined && state !== null && (!/^(?:0|[1-9]\d*)$/.test(String(state)) || Number(state) === 0))
            throw new Error(`Fresh tray ${index} is empty or its state is invalid.`);
        if (index < 254) {
            const bits = index >= 128 ? unit?.tray_exist_bits : raw.ams?.tray_exist_bits, slot = index >= 128 ? 0 : index;
            let occupied = false;
            if (bits !== undefined && bits !== null) {
                try {
                    const encoded = typeof bits === 'string' ? `0x${bits.replace(/^0x/i, '')}` : bits, mask = BigInt(encoded);
                    if (mask < 0n)
                        throw new Error();
                    occupied = (mask & (1n << BigInt(slot))) !== 0n;
                }
                catch {
                    throw new Error('Fresh AMS occupancy evidence is invalid.');
                }
                if (!occupied)
                    throw new Error(`Fresh tray ${index} is reported empty.`);
            }
            else if (state !== undefined && state !== null && Number(state) > 0 && typeof tray?.tray_info_idx === 'string' && tray.tray_info_idx.trim())
                occupied = true;
            if (!occupied)
                throw new Error(`Fresh AMS occupancy evidence is unavailable for tray ${index}.`);
        }
        if (!normalizeMaterial(tray?.tray_type) || normalizeMaterial(tray.tray_type) !== entry.material)
            throw new Error(`Fresh material identity is unavailable or mismatched for tray ${index}.`);
    }
}
/** Exactly one dispatch, after three independent fresh status reads and a renewed provider reference. */
export async function executeReferenceReprint(x) {
    const check = () => { x.signal?.throwIfAborted(); x.assertActive(); };
    check();
    await x.account.assertCurrent();
    const reads = { fetchTask: x.account.fetchTask, fetchProfile: x.account.fetchProfile };
    const reference = await resolveCompletedJobReference(x.taskId, x.serial, reads, x.currentMapping);
    const requirements = referenceRequirements(reference);
    if (!normalizeModel(reference.declared.deviceModel))
        throw new Error('requires_original_file');
    check();
    const first = await x.readStatus();
    requireKnownMaterials(first, requirements);
    const preflight = await x.confirm(first, reference);
    check();
    const second = await x.readStatus();
    requireKnownMaterials(second, requirements);
    x.assertPreflight(second, preflight);
    check();
    const headers = await x.headers();
    await revalidateCompletedJobReference(reference, reads, x.currentMapping);
    await x.account.assertCurrent(true);
    check();
    const final = await x.readStatus();
    requireKnownMaterials(final, requirements);
    x.assertPreflight(final, preflight);
    let sent = false;
    try {
        const newTaskId = await x.account.dispatch(reference.payload, headers, () => {
            check();
            requireKnownMaterials(final, requirements);
            x.assertPreflight(final, preflight);
            const nonce = x.prepareHandoff();
            try {
                check();
                requireKnownMaterials(final, requirements);
                x.assertPreflight(final, preflight);
            }
            catch (e) {
                x.discardHandoff(nonce);
                throw e;
            }
            x.onDispatch();
            sent = true;
        });
        x.onAccepted(newTaskId);
        return { sourceTaskId: reference.sourceTaskId, newTaskId, fingerprint: reference.fingerprint, verification: reference.verification, mappingSource: reference.declared.mappingSource, dispatch: 'unconfirmed' };
    }
    catch (e) {
        if (sent)
            throw new ReferenceDispatchUnknown(reference);
        throw e;
    }
}
