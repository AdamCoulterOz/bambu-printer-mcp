/** Narrow file-browser CTRL wire: research/06.07-tutk.md §6.7.4 and
 * research/09.06-commands.md, open-bamboo-networking 77de55a. */
import { createHash } from 'node:crypto';
import { deleteRequest } from './mutations.js';
export function makeControlRequest(op) {
    if (op.operation === 'delete') {
        deleteRequest(op.path, op.confirm, 2);
        if (op.expectedSize !== undefined && (!Number.isSafeInteger(op.expectedSize) || op.expectedSize < 0))
            throw Error('Invalid expected size');
        return makeControlRequest({ operation: 'list', kind: op.kind, storage: op.storage });
    }
    let req;
    if (op.operation === 'list') {
        if (!['model', 'video', 'timelapse'].includes(op.kind) || !['', 'internal', 'external', 'emmc', 'udisk', 'sdcard', 'usb'].includes(op.storage))
            throw Error('Invalid selector');
        req = { type: op.kind, api_version: 2, notify: 'DETAIL' };
        if (op.storage)
            req.storage = op.storage;
    }
    else {
        if (typeof op.path !== 'string' || !op.path.startsWith('/') || Buffer.byteLength(op.path) > 1024 || /[\x00-\x1f\x7f]/.test(op.path) || op.path.split('/').includes('..'))
            throw Error('Invalid path');
        req = { path: op.path, offset: 0 };
    }
    const bytes = Buffer.from(JSON.stringify({ cmdtype: op.operation === 'list' ? 1 : 4, sequence: 1, req }));
    if (bytes.length > 1020)
        throw Error('Control request too long');
    return bytes;
}
export class ControlReplies {
    constructor(operation, sequence = 1) {
        this.operation = operation;
        this.sequence = sequence;
        this.done = false;
        this.files = [];
        this.chunks = [];
        this.size = 0;
        this.listBytes = 0;
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff)
            throw Error('Invalid sequence');
    }
    consume(frame) {
        if (this.done || frame.length > 1024 * 1024)
            throw Error('Invalid control frame');
        const marker = frame.indexOf('\n\n'), header = marker < 0 ? frame : frame.subarray(0, marker), body = marker < 0 ? Buffer.alloc(0) : frame.subarray(marker + 2);
        if (header.length > 65536)
            throw Error('Control header too large');
        let value;
        try {
            value = JSON.parse(header.toString('utf8'));
        }
        catch {
            throw Error('Invalid control header');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw Error('Invalid control reply');
        const v = value;
        if (v.cmdtype === 0xffffffff && v.sequence === 0xffffffff || v.cmdtype === 0x100 || v.cmdtype === 0x101)
            return;
        const cmd = this.operation.operation === 'list' ? 1 : this.operation.operation === 'delete' ? 3 : 4;
        if (cmd === 3) {
            if (v.cmdtype !== cmd || v.sequence !== this.sequence || !Number.isSafeInteger(v.result) || body.length)
                throw Error('Unexpected delete reply');
            this.done = true;
            return { deleteResult: v.result };
        }
        if (v.cmdtype !== cmd || v.sequence !== this.sequence || ![0, 1].includes(v.result) || !v.reply || typeof v.reply !== 'object' || Array.isArray(v.reply))
            throw Error('Unexpected control reply');
        const r = v.reply;
        if (this.operation.operation === 'list') {
            this.listBytes += frame.length;
            if (body.length || !Array.isArray(r.file_lists) || this.files.length >= 4096 || this.listBytes > 8 * 1024 * 1024)
                throw Error('Invalid listing');
            this.files.push(r);
            if (v.result === 0) {
                this.done = true;
                return { replies: this.files };
            }
            return;
        }
        if (r.mem_dl_param_size || !Number.isSafeInteger(r.offset) || r.offset !== this.size || !Number.isSafeInteger(r.size) || r.size !== body.length || !Number.isSafeInteger(r.total) || Number(r.total) < 0 || Number(r.total) > 16 * 1024 * 1024 || this.total !== undefined && this.total !== r.total)
            throw Error('Invalid file fragment');
        this.total = Number(r.total);
        this.size += body.length;
        if (this.size > this.total)
            throw Error('Invalid file size');
        this.chunks.push(Buffer.from(body));
        if (v.result === 0) {
            const data = Buffer.concat(this.chunks);
            if (data.length !== this.total || typeof r.file_md5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(r.file_md5) || createHash('md5').update(data).digest('hex') !== r.file_md5.toLowerCase())
                throw Error('File checksum mismatch');
            this.done = true;
            return { bytes: data, size: data.length, md5: r.file_md5.toLowerCase() };
        }
    }
}
