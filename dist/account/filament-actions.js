const base = '/v1/design-user-service/my/filament/v2';
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function fields(value, allowed) {
    if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)))
        throw new Error('Invalid filament operation fields.');
    return value;
}
function text(value, label, max = 256) {
    if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value))
        throw new Error(`Invalid ${label}.`);
    return value;
}
function id(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw new Error('A positive numeric spool ID is required.');
    return value;
}
function rfid(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value) || /^0+$/.test(value))
        throw new Error('A nonzero 32-digit RFID is required.');
    return value.toUpperCase();
}
function byte(value) {
    if (!Number.isInteger(value) || value < 0 || value > 255)
        throw new Error('AMS identity must be an integer from 0 to 255.');
    return value;
}
const attributeNames = ['filamentName', 'filamentId', 'filamentType', 'filamentVendor', 'color', 'colorType', 'colors', 'netWeight', 'totalNetWeight', 'note', 'trayIdName', 'createType', 'isSupport', 'RFID', 'rolls', 'status'];
function attributes(value) {
    const a = fields(value, attributeNames);
    text(a.filamentName, 'filamentName');
    for (const key of ['filamentId', 'filamentType', 'filamentVendor', 'color', 'trayIdName', 'createType'])
        if (a[key] !== undefined)
            text(a[key], key);
    if (a.RFID !== undefined)
        rfid(a.RFID);
    for (const key of ['colorType', 'netWeight', 'totalNetWeight', 'rolls', 'status'])
        if (a[key] !== undefined && (!Number.isSafeInteger(a[key]) || (key !== 'netWeight' && a[key] < 0)))
            throw new Error(`Invalid ${key}.`);
    if (a.isSupport !== undefined && typeof a.isSupport !== 'boolean')
        throw new Error('Invalid isSupport.');
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 2048))
        throw new Error('Invalid note.');
    if (a.colors !== undefined && (!Array.isArray(a.colors) || a.colors.length > 16 || a.colors.some(v => typeof v !== 'string' || v.length > 32)))
        throw new Error('Invalid colors.');
    return { ...a };
}
function mapping(value) {
    const row = fields(value, ['operation', 'amsId', 'amsSn', 'amsType', 'slotId', 'spoolId', 'rfid']);
    if (row.operation !== 'bind' && row.operation !== 'unbind')
        throw new Error('Each mapping requires an explicit bind or unbind operation.');
    const m = { amsId: byte(row.amsId), amsType: byte(row.amsType), amsSn: text(row.amsSn, 'amsSn', 128), slotId: text(row.slotId, 'slotId', 32) };
    if (row.operation === 'unbind') {
        if (row.spoolId != null || row.rfid != null)
            throw new Error('Unbind must not specify spoolId or RFID.');
        Object.assign(m, { spoolId: null, rfid: null });
    }
    else
        Object.assign(m, { spoolId: id(row.spoolId), rfid: row.rfid == null ? null : rfid(row.rfid) });
    return m;
}
export function prepareFilamentAction(operation, payload, serial) {
    const p = object(payload) ? payload : payload === undefined ? {} : fields(payload, []);
    if (Buffer.byteLength(JSON.stringify(p)) > 65536)
        throw new Error('Filament payload exceeds 64 KiB.');
    if (operation === 'config') {
        fields(p, []);
        return { method: 'GET', path: '/v1/design-user-service/filament/config' };
    }
    if (operation === 'pending') {
        fields(p, ['amsSn']);
        const query = p.amsSn === undefined ? '' : '&amsSn=' + encodeURIComponent(text(p.amsSn, 'amsSn', 128));
        return { method: 'GET', path: base + '/soft-match/pending?devId=' + encodeURIComponent(serial) + query };
    }
    if (operation === 'create')
        return { method: 'POST', path: base, body: attributes(p) };
    if (operation === 'update') {
        const { id: value, ...remaining } = p;
        return { method: 'PUT', path: base, body: { ...attributes(remaining), id: id(value) } };
    }
    if (operation === 'delete') {
        fields(p, ['ids']);
        if (!Array.isArray(p.ids) || p.ids.length < 1 || p.ids.length > 100)
            throw new Error('Delete requires 1 to 100 spool IDs.');
        const ids = p.ids.map(id);
        if (new Set(ids).size !== ids.length)
            throw new Error('Duplicate spool IDs.');
        return { method: 'DELETE', path: base + '/batch', body: { ids: ids.map(String) } };
    }
    if (operation === 'sync_mappings') {
        fields(p, ['mappings']);
        if (!Array.isArray(p.mappings) || p.mappings.length < 1 || p.mappings.length > 32)
            throw new Error('Supply 1 to 32 explicit mappings.');
        const mappings = p.mappings.map(mapping);
        const identities = mappings.map(v => `${v.amsSn}/${v.slotId}`);
        if (new Set(identities).size !== identities.length)
            throw new Error('Duplicate slot mappings.');
        return { method: 'POST', path: base + '/slot-mappings/sync', body: { devId: serial, mappings } };
    }
    if (operation === 'sync_ams') {
        fields(p, ['items']);
        if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 32)
            throw new Error('Supply 1 to 32 complete AMS items.');
        const required = ['RFID', 'amsId', 'amsSn', 'amsType', 'slotId', 'color', 'colorType', 'colors', 'filamentId', 'filamentName', 'filamentType', 'filamentVendor', 'isSupport', 'netWeight', 'totalNetWeight', 'note', 'trayIdName'];
        const seenSlots = new Set(), seenRfids = new Set();
        const items = p.items.map(value => {
            const item = fields(value, [...required, 'createNew', 'spoolId']);
            if (required.some(key => !(key in item)))
                throw new Error('AMS item is incomplete.');
            const identifier = rfid(item.RFID);
            const slot = `${text(item.amsSn, 'amsSn', 128)}/${text(item.slotId, 'slotId', 32)}`;
            byte(item.amsId);
            byte(item.amsType);
            if (seenSlots.has(slot) || seenRfids.has(identifier))
                throw new Error('Duplicate AMS slot or RFID.');
            seenSlots.add(slot);
            seenRfids.add(identifier);
            attributes(Object.fromEntries(Object.entries(item).filter(([k]) => attributeNames.includes(k))));
            if (item.createNew !== undefined && typeof item.createNew !== 'boolean')
                throw new Error('Invalid createNew.');
            if (item.createNew === true && item.spoolId !== undefined)
                throw new Error('New AMS spool cannot specify an existing spoolId.');
            if (item.createNew !== true)
                id(item.spoolId);
            return { ...item, RFID: identifier, createNew: item.createNew === true };
        });
        return { method: 'POST', path: base + '/ams/sync', body: { devId: serial, items } };
    }
    if (operation === 'resolve_pending') {
        fields(p, ['action', 'spoolId', 'targetSpoolId']);
        if (!['accept', 'link_other', 'create_new'].includes(String(p.action)))
            throw new Error('Invalid pending-match action.');
        const target = p.action === 'link_other' ? id(p.targetSpoolId) : 0;
        if (p.action !== 'link_other' && p.targetSpoolId !== undefined)
            throw new Error('targetSpoolId is only valid for link_other.');
        return { method: 'POST', path: base + '/soft-match/pending', body: { action: p.action, spoolId: id(p.spoolId), targetSpoolId: target } };
    }
    throw new Error('Unknown filament operation.');
}
const resultFields = new Set(['id', 'spoolId', 'pendingId', 'targetSpoolId', 'code', 'results', 'hits', 'candidates', 'filamentV2', 'filamentId', 'filamentName', 'filamentType', 'filamentVendor', 'RFID', 'color', 'colors', 'colorType', 'netWeight', 'totalNetWeight', 'slotId', 'amsId', 'amsSn', 'amsType', 'devId', 'inPrinter', 'status', 'createType', 'note', 'trayIdName', 'isSupport', 'category', 'depleted', 'items', 'name', 'value', 'options', 'types', 'categories', 'filamentSettings', 'createdRFIDs']);
export function projectAccountResponse(value, depth = 0) {
    if (depth > 12)
        return null;
    if (Array.isArray(value))
        return value.slice(0, 2000).map(x => projectAccountResponse(x, depth + 1));
    if (object(value))
        return Object.fromEntries(Object.entries(value).filter(([k]) => resultFields.has(k)).map(([k, v]) => [k, projectAccountResponse(v, depth + 1)]));
    if (typeof value === 'string')
        return value.includes('://') ? null : value.slice(0, 2048);
    return typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null ? value : null;
}
export function classifyFilamentResult(operation, body, response) {
    if (operation === 'config' || operation === 'pending')
        return 'read';
    if ('code' in response && response.code !== 0 && response.code !== '0')
        return 'unknown';
    if ((operation === 'create' || operation === 'delete') && Object.keys(response).length === 0)
        return 'accepted';
    if (operation === 'update' && object(response.filamentV2) && response.filamentV2.id === body?.id)
        return 'accepted';
    if ((operation === 'sync_mappings' || operation === 'sync_ams') && body) {
        const requested = operation === 'sync_mappings' ? body.mappings : body.items;
        const rows = response.results;
        if (!Array.isArray(requested) || !Array.isArray(rows) || rows.length !== requested.length || rows.some(row => !object(row)))
            return 'unknown';
        const slots = rows.map(row => `${row.amsSn}/${row.slotId}`);
        if (new Set(slots).size !== slots.length || requested.some(row => !slots.includes(`${row.amsSn}/${row.slotId}`)))
            return 'unknown';
        if (operation === 'sync_ams') {
            return rows.every(row => Number.isSafeInteger(row.spoolId) && row.spoolId > 0 && requested.some(req => req.amsSn === row.amsSn && req.slotId === row.slotId && (req.createNew === true || req.spoolId === row.spoolId))) ? 'accepted' : 'unknown';
        }
        const codes = rows.map(row => row.code);
        if (codes.some(code => !Number.isSafeInteger(code)))
            return 'unknown';
        if (codes.every(code => code === 0))
            return 'accepted';
        if (codes.every(code => code !== 0))
            return 'rejected';
        return 'partial';
    }
    return 'unknown';
}
