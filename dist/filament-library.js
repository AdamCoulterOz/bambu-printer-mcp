const pageSize = 20;
const maxPages = 100;
const fail = () => { throw new Error('Bambu filament inventory snapshot is incomplete or invalid.'); };
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && v.length <= 4096 ? v : null;
const weight = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function canonicalSpoolRfid(v) {
    if (typeof v !== 'string' || !/^[0-9a-fA-F]{32}$/.test(v) || /^0{32}$/.test(v))
        return null;
    return v.toUpperCase();
}
const integer = (v) => typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
function spool(v) {
    if (!object(v))
        return fail();
    const id = typeof v.id === 'string' && /^[0-9]+$/.test(v.id) && v.id.length <= 20 ? v.id
        : typeof v.id === 'number' && Number.isSafeInteger(v.id) && v.id >= 0 ? String(v.id) : null;
    if (!id)
        return fail();
    const location = { source: 'account_report', freshness: 'not_guaranteed',
        in_printer: typeof v.inPrinter === 'boolean' ? v.inPrinter : null,
        device_id: string(v.devId), ams_serial: string(v.amsSn), ams_id: integer(v.amsId), ams_type: integer(v.amsType),
        slot_id: string(v.slotId) ?? (integer(v.slotId) === null ? null : String(v.slotId)), device_name: string(v.deviceName) };
    const reported_location = [location.in_printer, location.device_id, location.ams_serial, location.ams_id, location.ams_type, location.slot_id, location.device_name].some(x => x !== null) ? location : null;
    return { id, reported_location, filament_id: string(v.filamentId), rfid: canonicalSpoolRfid(v.RFID),
        brand: string(v.filamentVendor), material: string(v.filamentType), name: string(v.filamentName),
        color: string(v.color), colors: Array.isArray(v.colors) && v.colors.every(x => typeof x === 'string' && x.length <= 4096) ? v.colors : null,
        net_weight_g: weight(v.netWeight), total_net_weight_g: weight(v.totalNetWeight),
        status: typeof v.status === 'string' || (typeof v.status === 'number' && Number.isSafeInteger(v.status)) ? v.status : null,
        updated_at: typeof v.updatedAt === 'string' || (typeof v.updatedAt === 'number' && Number.isSafeInteger(v.updatedAt)) ? v.updatedAt : null };
}
/** No partial results: page errors, changed totals, duplicates and unproven termination fail. */
export async function readFilamentLibrary(request, timeoutMs = 30000, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason ?? new Error('Bambu filament inventory request cancelled.'));
    if (signal?.aborted)
        cancel();
    else
        signal?.addEventListener('abort', cancel, { once: true });
    const cancelled = new Promise((_, reject) => {
        if (controller.signal.aborted)
            reject(controller.signal.reason);
        else
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Bambu filament inventory snapshot timed out.'); controller.abort(error); reject(error); }, timeoutMs); });
    const work = async () => {
        const spools = [];
        const ids = new Set();
        let expected;
        let totalPresent;
        let offset = 0;
        for (let page = 0; page < maxPages; page++) {
            controller.signal.throwIfAborted();
            const response = await request(`/v1/design-user-service/my/filament/v2?offset=${offset}&limit=${pageSize}`, controller.signal);
            controller.signal.throwIfAborted();
            const body = object(response.data) && Array.isArray(response.data.hits) ? response.data : response;
            if (!Array.isArray(body.hits))
                return fail();
            const total = body.total;
            if (body.hits.length > (total === undefined && page === 0 ? pageSize * maxPages : pageSize))
                return fail();
            if (total !== undefined && (!Number.isSafeInteger(total) || total < 0 || total > pageSize * maxPages))
                return fail();
            const hasTotal = total !== undefined;
            if (totalPresent !== undefined && totalPresent !== hasTotal)
                return fail();
            totalPresent = hasTotal;
            if (total !== undefined) {
                if (expected !== undefined && expected !== total)
                    return fail();
                expected = total;
            }
            for (const item of body.hits) {
                const parsed = spool(item);
                if (ids.has(parsed.id))
                    return fail();
                ids.add(parsed.id);
                spools.push(parsed);
            }
            if (expected !== undefined && spools.length > expected)
                return fail();
            if (expected === undefined)
                return { source: 'bambu_account_cloud', fetched_at: new Date().toISOString(), retrieval_complete: true, retrieval_mode: 'single_catalogue_response', reported_total: null, consistency: 'not_guaranteed', spools };
            if (spools.length === expected)
                return { source: 'bambu_account_cloud', fetched_at: new Date().toISOString(), retrieval_complete: true, retrieval_mode: 'offset_pages', reported_total: expected, consistency: 'not_guaranteed', spools };
            if (body.hits.length === 0)
                return fail();
            offset += body.hits.length;
            if (offset > pageSize * maxPages)
                return fail();
        }
        return fail();
    };
    try {
        return await Promise.race([work(), deadline, cancelled]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.abort();
    }
}
/** A match requires a unique canonical cloud RFID and unique observed printer UUID. */
export function matchFilamentLibrary(spools, trays) {
    const cloudCounts = new Map();
    const trayCounts = new Map();
    for (const entry of spools) {
        const key = canonicalSpoolRfid(entry.rfid);
        if (key)
            cloudCounts.set(key, [...(cloudCounts.get(key) ?? []), entry]);
    }
    for (const tray of trays) {
        const key = canonicalSpoolRfid(tray.tray_uuid);
        if (key)
            trayCounts.set(key, (trayCounts.get(key) ?? 0) + 1);
    }
    return trays.map(tray => {
        const key = canonicalSpoolRfid(tray.tray_uuid);
        if (!key)
            return { status: 'unlinked', spool_id: null };
        const found = cloudCounts.get(key) ?? [];
        if (found.length > 1 || (trayCounts.get(key) ?? 0) > 1)
            return { status: 'ambiguous', spool_id: null };
        return found.length === 1 ? { status: 'matched', spool_id: found[0].id } : { status: 'unlinked', spool_id: null };
    });
}
/** Combine only strong identity matches. Unmatched observations may overlap library reels. */
export function unifyFilamentInventory(library, trays) {
    const matches = library ? matchFilamentLibrary(library.spools, trays) : null;
    const reported = trays.map((tray, index) => ({ tray, index, key: canonicalSpoolRfid(tray.tray_uuid) }));
    const cloudCounts = new Map(), trayCounts = new Map();
    for (const reel of library?.spools ?? []) {
        const key = canonicalSpoolRfid(reel.rfid);
        if (key)
            cloudCounts.set(key, (cloudCounts.get(key) ?? 0) + 1);
    }
    for (const { key } of reported)
        if (key)
            trayCounts.set(key, (trayCounts.get(key) ?? 0) + 1);
    const locationFor = (tray) => ({ source: 'printer_report', freshness: 'not_guaranteed',
        feed: tray.source ?? null, ams_id: tray.ams_id, tray_id: tray.tray_id, slot: tray.slot, label: tray.label,
        physical_extruder: tray.physical_extruder ?? null });
    const printerQuantity = (tray) => ({ remaining_percent: tray.remain_percent,
        remaining_weight_g: tray.remaining_weight_g ?? null, nominal_weight_g: tray.nominal_weight_g ?? null });
    const cloudRows = (library?.spools ?? []).map(reel => {
        const key = canonicalSpoolRfid(reel.rfid);
        const ambiguous = !!key && ((cloudCounts.get(key) ?? 0) > 1 || (trayCounts.get(key) ?? 0) > 1);
        const found = reported.find(({ index }) => matches?.[index].status === 'matched' && matches[index].spool_id === reel.id);
        const account = reel.reported_location;
        const accountLocation = account ? { ...account, updated_at: reel.updated_at, fetched_at: library.fetched_at } : null;
        const conflict = found && account?.in_printer === false ? 'account_reports_not_loaded' :
            found && account?.in_printer === true && ((account.ams_id !== null && found.tray.ams_id !== null && account.ams_id !== found.tray.ams_id) ||
                (account.slot_id !== null && found.tray.tray_id !== null && account.slot_id !== String(found.tray.tray_id))) ? 'account_binding_differs' : null;
        const load_state = found ? 'loaded' : ambiguous ? 'unknown' : account?.in_printer === false ? 'not_loaded' : account?.in_printer === true ? 'loaded' : 'unknown';
        return { identity: { source: 'account', id: reel.id }, ...reel, load_state,
            location: found ? locationFor(found.tray) : account?.in_printer !== null && account?.in_printer !== undefined ? accountLocation : null,
            load_state_evidence: found ? 'printer_uuid_match' : ambiguous ? 'ambiguous_identity' : account?.in_printer === false || account?.in_printer === true ? 'account_report' : 'unknown',
            account_report: accountLocation, conflict,
            quantities: { account: { net_weight_g: reel.net_weight_g, total_net_weight_g: reel.total_net_weight_g }, printer: found ? printerQuantity(found.tray) : null } };
    });
    const printerRows = reported.filter(({ tray, key }) => tray.loaded && key && trayCounts.get(key) === 1 && !cloudCounts.has(key)).map(({ tray, key }) => ({
        identity: { source: 'printer_uuid', id: key }, id: null, filament_id: tray.tray_info_idx, rfid: key,
        brand: null, material: tray.tray_type, name: tray.tray_sub_brands, name_source: 'tray_sub_brands', color: tray.tray_color, colors: null,
        may_overlap_library_records: true,
        load_state: 'loaded', location: locationFor(tray), load_state_evidence: 'printer_report',
        account_report: null, conflict: null,
        quantities: { account: null, printer: printerQuantity(tray) },
    }));
    const unidentified = reported.filter(({ tray, key, index }) => tray.loaded && (!key || (trayCounts.get(key) ?? 0) > 1 || (cloudCounts.get(key) ?? 0) > 1 || (library && cloudCounts.has(key) && matches?.[index].status !== 'matched'))).map(({ tray }) => tray);
    return { spools: cloudRows, unmatched_printer_spool_observations: printerRows, unidentified_loaded_slots: unidentified,
        coverage: { library: library ? 'available' : 'unavailable_or_not_requested', printer: 'reported_slots_only',
            library_records: library ? cloudRows.length : null, unmatched_printer_spool_observations: printerRows.length, unidentified_loaded_slots: unidentified.length,
            unknown_occupancy_slots: trays.filter(tray => tray.occupancy === 'unknown').length,
            unique_physical_count: null } };
}
