/** Framed AV data and Reed-Solomon groups, per research/06.07-tutk.md §6.7.3,
 * open-bamboo-networking 77de55a. Limits bound all untrusted printer data. */
import { recoverDataShards } from './fec.js';
export class FrameReceiver {
    constructor(emit, ordered = false) {
        this.emit = emit;
        this.ordered = ordered;
        this.groups = new Map();
        this.frames = new Map();
        this.delivered = new Set();
        this.pendingBytes = 0;
    }
    deliver(id, f) {
        const pieces = [];
        for (let i = 0; i < f.count; i++) {
            const p = f.pieces.get(i);
            if (!p)
                return;
            pieces.push(p);
        }
        const all = Buffer.concat(pieces);
        this.frames.delete(id);
        if (this.ordered)
            this.pendingBytes -= f.size;
        this.delivered.add(id);
        if (this.delivered.size > 64)
            this.delivered.delete(this.delivered.values().next().value);
        if (f.kind === 4)
            return;
        if (f.info > all.length || f.info && f.info < 3) {
            if (this.ordered)
                throw Error('Invalid ordered frame');
            return;
        }
        const end = all.length - f.info;
        if (!end)
            return;
        this.emit(all.subarray(0, end), f.kind === 5 || (f.info >= 3 && all[end + 2] === 1));
    }
    drain() {
        while (this.next !== undefined) {
            const id = this.next, f = this.frames.get(id);
            if (!f || f.pieces.size !== f.count)
                return;
            this.next = (id + 1) >>> 0;
            this.deliver(id, f);
        }
    }
    slice(data) {
        if (data.length < 20)
            return;
        const kind = data[0], last = data[1] === 1, count = data.readUInt16LE(4), raw = data.readUInt16LE(6), n = data.readUInt16LE(8), frameId = data.readUInt32LE(12), index = last ? count - 1 : raw, info = last ? raw : 0;
        if (![4, 5, 6, 7].includes(kind) || !count || count > 4096 || index >= count || n > 1024 || 20 + n > data.length || info > 64 || this.delivered.has(frameId))
            return;
        if (this.ordered) {
            if (this.next === undefined)
                this.next = frameId;
            const delta = (frameId - this.next) >>> 0;
            if (delta >= 0x80000000)
                return;
        }
        let f = this.frames.get(frameId);
        if (!f) {
            if (this.frames.size >= 16) {
                if (this.ordered)
                    throw Error('Ordered frame backlog exceeded');
                this.frames.delete(this.frames.keys().next().value);
            }
            f = { count, pieces: new Map(), info: 0, kind, size: 0 };
            this.frames.set(frameId, f);
        }
        if (f.count !== count || f.pieces.has(index))
            return;
        if (f.size + n > 4 * 1024 * 1024) {
            if (this.ordered)
                throw Error('Ordered frame too large');
            this.frames.delete(frameId);
            return;
        }
        if (this.ordered && this.pendingBytes + n > 16 * 1024 * 1024)
            throw Error('Ordered frame byte limit exceeded');
        f.size += n;
        if (this.ordered)
            this.pendingBytes += n;
        f.pieces.set(index, Buffer.from(data.subarray(20, 20 + n)));
        if (last)
            f.info = info;
        if (f.pieces.size !== count)
            return;
        if (this.ordered)
            this.drain();
        else
            this.deliver(frameId, f);
    }
    /** Accept one authenticated AV stream packet. Returns an embedded probe clock, if present. */
    accept(packet) {
        if (packet.length < 16 || packet[0] !== 0x0c || packet.readUInt16LE(2) !== 11)
            return;
        const embedded = (packet[1] & 8) !== 0, off = embedded ? 16 : 8;
        if (packet.length < off + 8)
            return;
        const clock = embedded ? packet.readUInt16LE(8) : undefined;
        const id = packet.readUInt16LE(off), index = packet[off + 2], k = packet[off + 3], m = packet.readUInt32LE(off + 4), body = packet.subarray(off + 8);
        if (!k)
            return clock;
        if (k > 32 || m > 32 || index >= k + m || !body.length || body.length > 1064)
            return clock;
        let g = this.groups.get(id);
        if (!g) {
            if (this.groups.size >= 8)
                this.groups.delete(this.groups.keys().next().value);
            g = { k, m, shards: new Map() };
            this.groups.set(id, g);
        }
        if (g.k !== k || g.m !== m || g.shards.has(index))
            return clock;
        if (index < k) {
            g.shards.set(index, Buffer.from(body));
            this.slice(body);
        }
        else {
            if (body.length < 20)
                return clock;
            const len = body.readUInt16LE(8);
            if (!len || len > 1044 || len + 20 > body.length || g.codeLength !== undefined && g.codeLength !== len)
                return clock;
            g.codeLength = len;
            g.shards.set(index, Buffer.from(body.subarray(20, 20 + len)));
        }
        if (g.codeLength && g.shards.size >= k) {
            const padded = new Map();
            for (const [i, b] of g.shards) {
                if (b.length > g.codeLength)
                    return clock;
                const p = Buffer.alloc(g.codeLength);
                b.copy(p);
                padded.set(i, p);
            }
            let recovered;
            try {
                recovered = recoverDataShards(k, padded, g.codeLength);
            }
            catch {
                this.groups.delete(id);
                return clock;
            }
            for (let i = 0; i < k; i++)
                if (!g.shards.has(i))
                    this.slice(recovered[i]);
            this.groups.delete(id);
        }
        else if (g.shards.size === k && [...g.shards.keys()].every(i => i < k))
            this.groups.delete(id);
        return clock;
    }
}
