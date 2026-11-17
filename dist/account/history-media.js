import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import sharp from 'sharp';
// One host was observed in an owned task; unknown hosts fail closed until supported.
const COVER_HOSTS = new Set(['or-cloud-model-prod.s3.dualstack.us-west-2.amazonaws.com']);
const MAX_BYTES = 5 * 1024 * 1024;
export function isPublicCoverAddress(address) {
    const p = address.split('.').map(Number);
    if (isIP(address) !== 4 || p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255))
        return false;
    const [a, b] = p;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 || b === 31 || b === 52 || b === 175) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0);
}
export function validateCoverUrl(value) {
    if (typeof value !== 'string' || value.length > 8192)
        throw new Error('Historical cover unavailable.');
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('Historical cover unavailable.');
    }
    const trusted = COVER_HOSTS.has(url.hostname) || url.hostname === 's3.us-west-2.amazonaws.com' && url.pathname.startsWith('/or-cloud-model-prod/');
    if (url.protocol !== 'https:' || !trusted || url.username || url.password || url.port || url.hash)
        throw new Error('Historical cover unavailable.');
    return url;
}
/** Downloads a task-owned URL with one verified DNS address pinned to the TLS
 * connection; redirects and credentials are never forwarded or exposed. */
export async function readHistoryCover(value, signal, dependencies) {
    const url = validateCoverUrl(value);
    const abort = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)]);
    let addresses;
    try {
        addresses = await new Promise((resolve, reject) => {
            const cancel = () => reject(new Error('cancelled'));
            if (abort.aborted)
                return cancel();
            abort.addEventListener('abort', cancel, { once: true });
            (dependencies?.resolve ? dependencies.resolve(url.hostname) : lookup(url.hostname, { all: true, family: 4 })).then(resolve, reject).finally(() => abort.removeEventListener('abort', cancel));
        });
    }
    catch {
        throw new Error('Historical cover unavailable.');
    }
    if (!addresses.length || addresses.some(v => !isPublicCoverAddress(v.address)))
        throw new Error('Historical cover unavailable.');
    const ip = addresses[0].address;
    const bytes = await new Promise((resolve, reject) => {
        const fail = () => reject(new Error('Historical cover unavailable.'));
        const req = (dependencies?.request ?? get)(url, { signal: abort, agent: false, family: 4, lookup: (_host, _options, callback) => callback(null, ip, 4) }, res => {
            if (res.statusCode !== 200 || Number(res.headers['content-length'] ?? 0) > MAX_BYTES) {
                res.resume();
                fail();
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => { size += chunk.length; if (size > MAX_BYTES) {
                res.destroy();
                fail();
            }
            else
                chunks.push(chunk); });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', fail);
        });
        req.on('error', fail);
    });
    try {
        const meta = await sharp(bytes, { limitInputPixels: 16000000, failOn: 'error' }).metadata();
        if (!meta.width || !meta.height || !['jpeg', 'png'].includes(meta.format ?? ''))
            throw new Error();
        // Force full decoding; metadata alone accepts some truncated inputs.
        await sharp(bytes, { limitInputPixels: 16000000, failOn: 'error' }).stats();
        return { bytes, mimeType: meta.format === 'png' ? 'image/png' : 'image/jpeg' };
    }
    catch {
        throw new Error('Historical cover unavailable.');
    }
}
