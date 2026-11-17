/** Provider completed-job reference, not an inspected file or a dispatch.
 * Handy 4.4.1: sgn.java:141,198-224; bx9.java:860-883;
 * nv9.java:3307-3464,8936-9727,13700-13746; tx7.java:41-94;
 * yq9.java declares GET model/profile and POST my/task.
 */
import { createHash } from 'node:crypto';
const canonicalSlot = (flat, unit, slot) => (flat >= 0 && flat <= 15 && unit === Math.floor(flat / 4) && slot === flat % 4) || (flat >= 128 && flat <= 255 && unit === flat && slot === 0);
const refuse = () => { throw new Error('requires_original_file'); };
const object = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function string(x, expression) { if (typeof x !== 'string' || !expression.test(x))
    return refuse(); return x; }
function id(x) {
    if (typeof x === 'number') {
        if (!Number.isSafeInteger(x) || x < 1)
            return refuse();
        return String(x);
    }
    return string(x, /^[1-9]\d{0,19}$/);
}
function safeNumber(x) { const n = Number(id(x)); if (!Number.isSafeInteger(n) || n < 1)
    return refuse(); return n; }
function integers(x, min, max, required = false) {
    if (x === undefined || x === null) {
        if (required)
            return refuse();
        return undefined;
    }
    if (!Array.isArray(x) || x.length > 64 || (required && !x.length) || x.some(n => !Number.isInteger(n) || n < min || n > max))
        return refuse();
    return [...x];
}
function mapping2(x) {
    if (x === undefined || x === null)
        return undefined;
    if (!Array.isArray(x) || x.length > 64)
        return refuse();
    return x.map(row => { if (!object(row) || !Number.isInteger(row.amsId) || !Number.isInteger(row.slotId) || Number(row.amsId) < 0 || Number(row.amsId) > 255 || Number(row.slotId) < 0 || Number(row.slotId) > 255)
        return refuse(); return { amsId: Number(row.amsId), slotId: Number(row.slotId) }; });
}
function details(x) {
    if (!Array.isArray(x) || !x.length || x.length > 64)
        return refuse();
    return x.map(row => {
        if (!object(row))
            return refuse();
        for (const k of ['ams', 'nozzleId'])
            if (!Number.isInteger(row[k]) || Number(row[k]) < 0 || Number(row[k]) > (k === 'nozzleId' ? 1 : 255))
                return refuse();
        const out = { ams: Number(row.ams), nozzleId: Number(row.nozzleId) };
        if ((row.amsId == null) !== (row.slotId == null))
            return refuse();
        if (row.amsId != null) {
            for (const k of ['amsId', 'slotId']) {
                if (!Number.isInteger(row[k]) || Number(row[k]) < 0 || Number(row[k]) > 255)
                    return refuse();
                out[k] = Number(row[k]);
            }
        }
        for (const k of ['sourceColor', 'targetColor', 'filamentType', 'targetFilamentType'])
            if (row[k] != null)
                out[k] = string(row[k], k.endsWith('Color') ? /^(?:[0-9A-Fa-f]{8})?$/ : /^[A-Za-z0-9+_. -]{0,80}$/);
        if (row.weight != null) {
            if (typeof row.weight !== 'number' || !Number.isFinite(row.weight) || row.weight < 0 || row.weight > 100000)
                return refuse();
            out.weight = row.weight;
        }
        return out;
    });
}
function project(task, profile, requestedId, serial, currentMapping) {
    if (!object(task) || !object(profile) || id(task.id) !== requestedId || task.deviceId !== serial || task.status !== 2 || task.isPrintable !== true || task.isDelete === true || !['cloud_file', 'lan_file', 'auto_repeat'].includes(String(task.mode)))
        return refuse();
    const modelId = string(task.modelId, /^[A-Za-z0-9_-]{1,128}$/), profileId = safeNumber(task.profileId), instanceId = safeNumber(task.instanceId);
    if (safeNumber(profile.profileId) !== profileId || (profile.modelId !== undefined && profile.modelId !== modelId))
        return refuse();
    const plateIndex = task.plateIndex;
    if (!Number.isSafeInteger(plateIndex) || Number(plateIndex) < 1 || Number(plateIndex) > 999)
        return refuse();
    const deviceModel = string(task.deviceModel, /^[A-Za-z0-9 ._-]{1,80}$/), bedType = string(task.bedType, /^[A-Za-z0-9 _-]{1,80}$/);
    if (typeof task.useAms !== 'boolean' || typeof task.isPublicProfile !== 'boolean')
        return refuse();
    const extension = profile.extention;
    if (!object(extension) || !object(extension.modelInfo) || !Array.isArray(extension.modelInfo.plates))
        return refuse();
    const plates = extension.modelInfo.plates.filter(p => object(p) && p.index === plateIndex);
    if (plates.length !== 1 || !object(plates[0]))
        return refuse();
    const plate = plates[0];
    const parseNozzles = (value) => {
        if (value === undefined || value === null)
            return undefined;
        let values;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!/^\d+(?:\.\d+)?(?: +\d+(?:\.\d+)?)*$/.test(trimmed))
                return refuse();
            values = trimmed.split(/ +/).map(Number);
        }
        else if (Array.isArray(value))
            values = value.map(item => typeof item === 'string' && /^\d+(?:\.\d+)?$/.test(item) ? Number(item) : item);
        else
            return refuse();
        if (values.length < 1 || values.length > 2 || values.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0.1 || n > 2))
            return refuse();
        return values;
    };
    const a = parseNozzles(plate.nozzleDiameters), b = parseNozzles(plate.nozzle_diameters);
    if (a && b && (a.length !== b.length || a.some((n, i) => n !== b[i])))
        return refuse();
    const profileNozzles = a ?? b;
    let taskNozzles;
    if (task.nozzleInfos !== undefined && task.nozzleInfos !== null) {
        if (!Array.isArray(task.nozzleInfos) || task.nozzleInfos.length > 2)
            return refuse();
        if (task.nozzleInfos.length) {
            const rows = task.nozzleInfos.map(n => { if (!object(n) || !Number.isInteger(n.id) || Number(n.id) < 0 || Number(n.id) > 1 || typeof n.diameter !== 'number' || !Number.isFinite(n.diameter) || n.diameter < 0.1 || n.diameter > 2)
                return refuse(); return { id: Number(n.id), diameter: n.diameter }; }).sort((x, y) => x.id - y.id);
            if (rows.some((n, i) => n.id !== i))
                return refuse();
            taskNozzles = rows.map(n => n.diameter);
        }
    }
    if (!profileNozzles && !taskNozzles)
        return refuse();
    if (profileNozzles && taskNozzles && (profileNozzles.length !== taskNozzles.length || profileNozzles.some((n, i) => n !== taskNozzles[i])))
        return refuse();
    const nozzles = taskNozzles ?? profileNozzles;
    const nozzleSource = taskNozzles ? (profileNozzles ? 'task_and_profile' : 'task') : 'profile';
    if (!Array.isArray(plate.filaments) || !plate.filaments.length || plate.filaments.length > 64)
        return refuse();
    const materials = plate.filaments.map(f => { if (!object(f))
        return refuse(); const n = safeNumber(f.id); if (n > 64)
        return refuse(); return { id: n, type: string(f.type, /^[A-Za-z0-9+_. -]{1,80}$/) }; });
    if (new Set(materials.map(m => m.id)).size !== materials.length)
        return refuse();
    let amsMapping = integers(task.amsMapping, -1, 255, task.useAms), amsMapping2 = mapping2(task.amsMapping2), nozzleMapping = integers(task.nozzleMapping, 0, 1);
    if (amsMapping && amsMapping2 && amsMapping.length !== amsMapping2.length)
        return refuse();
    if (amsMapping && materials.some(m => m.id > amsMapping.length))
        return refuse();
    if (nozzleMapping && materials.some(m => m.id > nozzleMapping.length))
        return refuse();
    let detail = details(task.amsDetailMapping);
    if (!amsMapping || !amsMapping2)
        return refuse();
    const oldAms = amsMapping, oldAms2 = amsMapping2;
    if (currentMapping === undefined) {
        const used = materials.map(m => m.id - 1);
        if (used.some(i => !oldAms2[i] || !canonicalSlot(oldAms[i], oldAms2[i].amsId, oldAms2[i].slotId)) || new Set(used.map(i => oldAms[i])).size !== used.length)
            throw new Error('requires_current_mapping');
    }
    const physicalNozzleIndices = materials.map(m => {
        const index = m.id - 1, slot = oldAms2[index];
        if (!slot || oldAms[index] < 0)
            return refuse();
        const matches = detail.filter(d => d.ams === oldAms[index]);
        if (matches.length !== 1 || matches[0].nozzleId === undefined || matches[0].nozzleId >= nozzles.length || (nozzleMapping && nozzleMapping[index] !== matches[0].nozzleId))
            return refuse();
        if (!currentMapping && matches[0].amsId !== undefined && (matches[0].amsId !== slot.amsId || matches[0].slotId !== slot.slotId))
            throw new Error('requires_current_mapping');
        if (!currentMapping && matches[0].amsId !== undefined && detail.filter(d => d.amsId === slot.amsId && d.slotId === slot.slotId).length !== 1)
            return refuse();
        return matches[0].nozzleId;
    });
    if (currentMapping !== undefined) {
        if (!Array.isArray(currentMapping) || currentMapping.length !== materials.length)
            return refuse();
        const chosen = new Map();
        for (const row of currentMapping) {
            if (!object(row) || Object.keys(row).sort().join(',') !== 'ams,amsId,filamentId,slotId' || !Number.isInteger(row.filamentId) || !Number.isInteger(row.ams) || !Number.isInteger(row.amsId) || !Number.isInteger(row.slotId))
                return refuse();
            const flat = Number(row.ams), unit = Number(row.amsId), slot = Number(row.slotId);
            if (!canonicalSlot(flat, unit, slot) || chosen.has(Number(row.filamentId)))
                return refuse();
            chosen.set(Number(row.filamentId), row);
        }
        if (materials.some(m => !chosen.has(m.id)) || new Set([...chosen.values()].map(row => row.ams)).size !== materials.length)
            return refuse();
        const length = Math.max(...materials.map(m => m.id));
        amsMapping = Array(length).fill(-1);
        amsMapping2 = Array.from({ length }, () => ({ amsId: 255, slotId: 255 }));
        detail = Array.from({ length }, () => ({ ams: -1 }));
        nozzleMapping = undefined;
        materials.forEach((m, i) => { const row = chosen.get(m.id); amsMapping[m.id - 1] = row.ams; amsMapping2[m.id - 1] = { amsId: row.amsId, slotId: row.slotId }; detail[m.id - 1] = { ams: row.ams, amsId: row.amsId, slotId: row.slotId, nozzleId: physicalNozzleIndices[i] }; });
    }
    return { verification: 'provider_completed_job_reference', sourceTaskId: requestedId, sourceMode: task.mode, payload: { mode: 'auto_repeat', deviceId: serial, modelId, profileId, instanceId, plateIndex: Number(plateIndex), bedType, useAms: task.useAms, isPublicProfile: task.isPublicProfile, ...(amsMapping ? { amsMapping } : {}), ...(amsMapping2 ? { amsMapping2 } : {}), ...(nozzleMapping ? { nozzleMapping } : {}), amsDetailMapping: detail }, declared: { deviceModel, nozzleDiameters: [...nozzles], nozzleSource, materials: materials.map((m, i) => ({ ...m, nozzle: physicalNozzleIndices[i] })), physicalNozzleIndices, mappingSource: currentMapping ? 'explicit_current_selection' : 'historical' } };
}
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** The supplied readers must query the current owned account, not cached history. */
export async function resolveCompletedJobReference(taskId, serial, reads, currentMapping) {
    const requested = id(taskId);
    string(serial, /^[A-Za-z0-9_-]{4,128}$/);
    const task = await reads.fetchTask(requested);
    if (!object(task) || id(task.id) !== requested || task.deviceId !== serial || task.status !== 2 || task.isPrintable !== true)
        return refuse();
    const model = string(task.modelId, /^[A-Za-z0-9_-]{1,128}$/), profile = safeNumber(task.profileId);
    const reference = project(task, await reads.fetchProfile(model, profile), requested, serial, currentMapping);
    return { ...reference, fingerprint: fingerprint(reference) };
}
/** Re-fetch immediately before final preflight and dispatch; caller owns live printer checks. */
export async function revalidateCompletedJobReference(reference, reads, currentMapping) {
    const { fingerprint: expected, ...prior } = reference;
    if (fingerprint(prior) !== expected)
        return refuse();
    const fresh = await resolveCompletedJobReference(reference.sourceTaskId, reference.payload.deviceId, reads, currentMapping);
    if (fresh.fingerprint !== reference.fingerprint)
        return refuse();
    return fresh;
}
