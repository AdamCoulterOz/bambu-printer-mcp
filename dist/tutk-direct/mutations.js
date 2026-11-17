/** Source-backed FILE_UPLOAD and FILE_DEL wire builders. No transport or retry. */
import { createHash, randomBytes } from 'node:crypto';
const MAX_UPLOAD = 16 * 1024 * 1024;
function validPath(path) { return typeof path === 'string' && path.startsWith('/') && Buffer.byteLength(path) <= 1024 && !/[\x00-\x1f\x7f*?\[\]]/.test(path) && !path.split('/').some(x => x === '..' || x === '.'); }
export function deleteRequest(path, confirm, sequence = 1) {
    if (confirm !== true || !validPath(path) || path.endsWith('/') || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff)
        throw Error('Invalid delete request');
    const bytes = Buffer.from(JSON.stringify({ cmdtype: 3, sequence, req: { paths: [path] } }));
    if (bytes.length > 1020)
        throw Error('Delete request too long');
    return bytes;
}
export function correlatedMutationReply(value, command, sequence) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid mutation reply');
    const v = value;
    if (v.cmdtype !== command || v.sequence !== sequence || !Number.isSafeInteger(v.result))
        throw Error('Unmatched mutation reply');
    return v.result;
}
export function prepareUpload(source, name, storage, allowHistoryRotation, sequence = 1, externalCapabilityVerified = false) {
    if (!Buffer.isBuffer(source) || source.length === 0 || source.length > MAX_UPLOAD || !['emmc', 'udisk'].includes(storage) || storage === 'emmc' && allowHistoryRotation !== true || storage === 'udisk' && externalCapabilityVerified !== true || typeof name !== 'string' || !/^[-A-Za-z0-9_ .]{1,180}$/.test(name) || name === '.' || name === '..' || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff)
        throw Error('Invalid upload request');
    const bytes = Buffer.from(source), dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    const remoteName = `${stem}-${randomBytes(16).toString('hex')}${ext}`, md5 = createHash('md5').update(bytes).digest('hex'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const init = Buffer.from(JSON.stringify({ mtype: 12289, cmdtype: 5, sequence, req: { type: 'model', storage, path: remoteName, total: bytes.length } }));
    return { remoteName, size: bytes.length, md5, sha256, init, chunks(chunkKiB, offset) {
            if (!Number.isSafeInteger(chunkKiB) || chunkKiB < 1 || chunkKiB > 31 || offset !== 0)
                throw Error('Invalid upload initialization');
            const chunkSize = chunkKiB * 1024, result = [];
            for (let at = 0, id = 0; at < bytes.length; at += chunkSize, id++) {
                const body = bytes.subarray(at, Math.min(bytes.length, at + chunkSize));
                const req = { frag_id: id, offset: at, size: body.length };
                if (at + body.length === bytes.length)
                    req.file_md5 = md5;
                result.push(Buffer.concat([Buffer.from(JSON.stringify({ mtype: 12289, cmdtype: 5, sequence, req }) + '\n\n'), body]));
            }
            return result;
        } };
}
export class UploadRejected extends Error {
}
/** One-shot upload receipt state; caller owns I/O and must never replay a handoff. */
export class UploadReceipt {
    constructor(job, sequence = 1) {
        this.job = job;
        this.sequence = sequence;
        this.stage = 'init';
    }
    initialized(value) {
        if (this.stage !== 'init')
            throw Error('Invalid upload state');
        const result = correlatedMutationReply(value, 5, this.sequence);
        if (result !== 1)
            throw new UploadRejected(result === 19 ? 'Upload target already exists' : 'Upload init rejected');
        const v = value;
        const chunks = this.job.chunks(v.reply?.chunk_size, v.reply?.offset);
        this.stage = 'sending';
        return chunks;
    }
    completed(value) {
        if (this.stage !== 'sending')
            throw Error('Invalid upload state');
        if (correlatedMutationReply(value, 5, this.sequence) !== 0)
            throw new UploadRejected('Upload completion rejected');
        this.stage = 'verify';
    }
    verified(bytes) {
        if (this.stage !== 'verify' || !Buffer.isBuffer(bytes) || bytes.length !== this.job.size || createHash('sha256').update(bytes).digest('hex') !== this.job.sha256 || createHash('md5').update(bytes).digest('hex') !== this.job.md5)
            throw Error('Upload readback mismatch');
        this.stage = 'done';
        return { status: 'verified', size: bytes.length, sha256: this.job.sha256, md5: this.job.md5 };
    }
    unreadable() {
        if (this.stage !== 'verify')
            throw Error('Invalid upload state');
        this.stage = 'done';
        return { status: 'uploaded_unverified', reason: 'readback_unavailable' };
    }
}
export class MutationFailure extends Error {
    constructor(receipt) {
        super(`Remote ${receipt.operation} ${receipt.status}`);
        this.receipt = receipt;
        this.name = 'MutationFailure';
    }
}
/** The mutation marker is set synchronously before effectful I/O and cannot reset. */
export class MutationHandoff {
    constructor(operation, path, digest) {
        this.operation = operation;
        this.path = path;
        this.digest = digest;
        this.sent = false;
    }
    beforeSend() { if (this.sent)
        throw new Error('Mutation handoff already marked'); this.sent = true; }
    receipt(status, reason) {
        if ((status === 'not_sent') === this.sent)
            throw new Error('Invalid handoff status');
        return { status, operation: this.operation, path: this.path, retryable: false, ...this.digest, ...(this.operation === 'upload' && this.sent && this.digest?.historyRotationAllowed ? { historyEffectsUncertain: true } : {}), ...(this.operation === 'upload' && this.sent && (status === 'unknown' || status === 'rejected') ? { fileEffectsUncertain: true } : {}), ...(reason ? { reason } : {}) };
    }
    failure() { return new MutationFailure(this.receipt(this.sent ? 'unknown' : 'not_sent')); }
}
