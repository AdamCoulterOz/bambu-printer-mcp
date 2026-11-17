/** Cloud protocol facts: ClusterM/open-bamboo-networking 77de55a8c696c53125ca297bdf3fdf1258772335, src/cloud_print.cpp and research/10.05-http-pop.md. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createHttpProof } from './signing/http-proof.js';
import { buildCloudProjectMedia } from './cloud-project-media.js';
const MAX_FILE = 256 * 1024 * 1024;
function shortId(value) {
    const str = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(str))
        throw new Error('Invalid cloud project response; a project may have been created.');
    return str;
}
function uploadUrl(value) {
    if (typeof value !== 'string' || value.length > 8192)
        throw new Error('Invalid cloud upload URL.');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('Invalid cloud upload URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !/(^|\.)(amazonaws\.com|aliyuncs\.com)$/.test(url.hostname))
        throw new Error('Untrusted cloud upload URL.');
    return value;
}
async function json(response) {
    if (!response.body)
        throw new Error('Invalid cloud response.');
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            length += value.length;
            if (length > 1024 * 1024) {
                await reader.cancel();
                throw new Error('Invalid cloud response.');
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const result = JSON.parse(text, (key, value, context) => {
        if (key === 'id' && typeof value === 'number' && !Number.isSafeInteger(value)) {
            if (!context?.source || !/^\d+$/.test(context.source))
                throw new Error('Unsafe cloud task ID.');
            return context.source;
        }
        return value;
    });
    if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('Invalid cloud response.');
    const data = result;
    if (data.code !== undefined && data.code !== null && data.code !== 0 && data.code !== '0')
        throw new Error('Cloud service rejected the request.');
    if (data.error !== undefined && data.error !== null && data.error !== '' && data.error !== false)
        throw new Error('Cloud service rejected the request.');
    return data;
}
/** Mutations are never retried. In particular POST /my/task is itself a print dispatch. */
export async function submitCloudPrint(o) {
    const signal = AbortSignal.any([o.signal ?? new AbortController().signal, AbortSignal.timeout(300000)]);
    if (!/^u_\d{1,20}$/.test(o.username) || !o.token || !Number.isSafeInteger(o.plate) || o.plate < 1 || !/^[a-f0-9]{64}$/i.test(o.sha256))
        throw new Error('Invalid cloud print configuration.');
    const info = await stat(o.filePath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE)
        throw new Error('Cloud print snapshot is outside the supported size.');
    const file = await readFile(o.filePath);
    if (file.length !== info.size || createHash('sha256').update(file).digest('hex') !== o.sha256.toLowerCase())
        throw new Error('Cloud print snapshot changed after inspection.');
    const media = await buildCloudProjectMedia(file, o.plate, o.sha256.toLowerCase());
    signal.throwIfAborted();
    o.assertAuthority?.();
    const md5 = createHash('md5').update(file).digest('hex').toUpperCase();
    const fetcher = o.fetcher ?? fetch;
    const proofFactory = o.proofFactory ?? createHttpProof;
    const headers = { ...o.clientHeaders, authorization: `Bearer ${o.token}`, accept: 'application/json', 'content-type': 'application/json' };
    const call = async (method, path, body, proof, dispatch = false) => {
        signal.throwIfAborted();
        o.assertAuthority?.();
        let response;
        const request = { method, headers: { ...headers, ...proof }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) };
        if (dispatch)
            o.onDispatch();
        try {
            response = await fetcher(o.api + path, request);
        }
        catch {
            throw new Error(method === 'GET' ? 'Cloud print read failed.' : 'Cloud print write outcome is uncertain; inspect the account and printer before retrying.');
        }
        if (!response.ok)
            throw new Error(`Cloud print ${method} returned HTTP ${response.status}${method === 'GET' ? '.' : '; inspect the account and printer before retrying.'}`);
        try {
            return await json(response);
        }
        catch {
            throw new Error(method === 'GET' ? 'Invalid cloud response.' : 'Invalid cloud write response; inspect the account and printer before retrying.');
        }
    };
    const put = async (url, content) => {
        signal.throwIfAborted();
        o.assertAuthority?.();
        let response;
        try {
            response = await fetcher(uploadUrl(url), { method: 'PUT', body: new Uint8Array(content), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
        }
        catch {
            throw new Error('Cloud upload outcome is uncertain; inspect the account before retrying.');
        }
        if (!response.ok)
            throw new Error(`Cloud upload returned HTTP ${response.status}; inspect the account before retrying.`);
    };
    // Validate the key before creating any account state; a fresh proof is generated immediately before dispatch.
    await proofFactory(o.signingDirectory);
    const project = await call('POST', '/v1/iot-service/api/user/project', { name: o.filename });
    const projectId = shortId(project.project_id), modelId = shortId(project.model_id), profileId = shortId(project.profile_id);
    if (typeof project.upload_ticket !== 'string' || !project.upload_ticket || project.upload_ticket.length > 2048 || /[\x00-\x1f\x7f]/.test(project.upload_ticket))
        throw new Error('Invalid cloud upload ticket; inspect the account before retrying.');
    const ticket = project.upload_ticket;
    const profileNumber = Number(profileId);
    if (!/^\d+$/.test(profileId) || !Number.isSafeInteger(profileNumber) || profileNumber < 0)
        throw new Error('Invalid cloud profile; inspect the account before retrying.');
    await put(uploadUrl(project.upload_url), media.config3mf);
    await call('PUT', '/v1/iot-service/api/user/notification', { upload: { origin_file_name: o.filename, ticket } });
    let completed = false;
    for (let i = 0; i < 20; i++) {
        const status = await call('GET', `/v1/iot-service/api/user/notification?action=upload&ticket=${encodeURIComponent(ticket)}`);
        if (status.message === 'success') {
            completed = true;
            break;
        }
        if (status.message !== 'running')
            throw new Error('Cloud config processing failed; inspect the account before retrying.');
        await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new Error('Cloud print cancelled.')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted)
                abort();
        });
    }
    if (!completed)
        throw new Error('Cloud config processing timed out; inspect the account before retrying.');
    const slot = `${modelId}_${profileId}_${o.plate}.3mf`;
    const result = await call('GET', `/v1/iot-service/api/user/upload?models=${encodeURIComponent(slot)}`);
    if (!Array.isArray(result.urls) || result.urls.length !== 1 || !result.urls[0] || typeof result.urls[0] !== 'object')
        throw new Error('Invalid cloud upload response; inspect the account before retrying.');
    const url = uploadUrl(result.urls[0].url);
    await put(url, file);
    await call('PATCH', `/v1/iot-service/api/user/project/${projectId}`, { profile_id: profileId, profile_print_3mf: [{ md5, plate_idx: o.plate, url }] });
    const proof = await proofFactory(o.signingDirectory);
    await o.beforeDispatch();
    signal.throwIfAborted();
    const task = await call('POST', '/v1/user-service/my/task', { ...o.task, modelId, profileId: profileNumber, plateIndex: o.plate, mode: 'cloud_file' }, proof, true);
    let taskId;
    try {
        taskId = shortId(task.id);
    }
    catch {
        throw new Error('Cloud task response did not include an ID; print dispatch is uncertain. Check printer and history before retrying.');
    }
    return { projectId, taskId, dispatch: 'unconfirmed', cover_source: 'selected_plate_config', cover_processing: 'unconfirmed' };
}
