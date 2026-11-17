/**
 * The DTLS 1.2 client profile used inside an established Bambu IOTC path.
 * Wire reference: open-bamboo-networking 77de55a8c696c53125ca297bdf3fdf1258772335,
 * research/06.07-tutk.md §6.7.2 and src/camera/tutk/IotcClient.cpp:554–1297.
 * The injected transport handles IOTC envelopes, peer selection and socket lifetime.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, timingSafeEqual, } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const DTLS_12 = 0xfefd;
const DTLS_10 = 0xfeff;
const HANDSHAKE = 22;
const CHANGE_CIPHER = 20;
const ALERT = 21;
const APPLICATION = 23;
const AES_CBC = 0xc038;
const CHACHA = 0xccac;
const IDENTITY = Buffer.from('AUTHPWD_admin');
const X25519_PARAMS = Buffer.from([0, 0, 3, 0, 29, 32]);
const X25519_PUBLIC_DER = Buffer.from('302a300506032b656e032100', 'hex');
const MAX_PLAINTEXT = 16384;
const MAX_CIPHERTEXT = MAX_PLAINTEXT + 320;
const MAX_DATAGRAM = 65479; // IPv4 UDP payload less the 28-byte IOTC envelope
const MAX_SEQUENCE = 2 ** 48;
const REPLAY_WINDOW = 64;
const REPLAY_MASK = (1n << BigInt(REPLAY_WINDOW)) - 1n;
export class DtlsError extends Error {
}
class InvalidRecord extends DtlsError {
}
class DeadlineExpired extends DtlsError {
}
function u16(value) {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
}
function vector16(data) {
    return Buffer.concat([u16(data.length), data]);
}
function pskFromPassword(password) {
    if (!password || Buffer.byteLength(password) > 1024 || password.includes('\0')) {
        throw new DtlsError('Invalid DTLS ticket password');
    }
    const digest = createHash('sha256').update(password, 'utf8').digest();
    // The printer stores the digest as a C string in a zero-filled 32-byte field.
    const zero = digest.indexOf(0);
    if (zero !== -1)
        digest.fill(0, zero);
    return digest;
}
function prf(digest, secret, label, seed, length) {
    const labelSeed = Buffer.concat([Buffer.from(label, 'ascii'), seed]);
    let state = labelSeed;
    let bytes = 0;
    const blocks = [];
    while (bytes < length) {
        state = createHmac(digest, secret).update(state).digest();
        const block = createHmac(digest, secret).update(state).update(labelSeed).digest();
        blocks.push(block);
        bytes += block.length;
    }
    return Buffer.concat(blocks, length);
}
function message(kind, number, body) {
    const header = Buffer.alloc(12);
    header[0] = kind;
    header.writeUIntBE(body.length, 1, 3);
    header.writeUInt16BE(number, 4);
    header.writeUIntBE(body.length, 9, 3);
    return Buffer.concat([header, body]);
}
function* messages(data) {
    for (let offset = 0; offset < data.length;) {
        if (data.length - offset < 12)
            throw new DtlsError('Truncated DTLS handshake message');
        const bodySize = data.readUIntBE(offset + 1, 3);
        const end = offset + 12 + bodySize;
        if (end > data.length || data.readUIntBE(offset + 6, 3) !== 0 ||
            data.readUIntBE(offset + 9, 3) !== bodySize) {
            throw new DtlsError('Unsupported DTLS handshake fragmentation');
        }
        yield {
            kind: data[offset],
            number: data.readUInt16BE(offset + 4),
            body: data.subarray(offset + 12, end),
            wire: data.subarray(offset, end),
        };
        offset = end;
    }
}
function record(kind, epoch, sequence, data, version = DTLS_12) {
    const header = Buffer.alloc(13);
    header[0] = kind;
    header.writeUInt16BE(version, 1);
    header.writeUInt16BE(epoch, 3);
    header.writeUIntBE(sequence, 5, 6);
    header.writeUInt16BE(data.length, 11);
    return Buffer.concat([header, data]);
}
function decodeRecords(datagram) {
    if (!datagram.length || datagram.length > MAX_DATAGRAM) {
        throw new InvalidRecord('Invalid DTLS datagram size');
    }
    const records = [];
    for (let offset = 0; offset < datagram.length;) {
        if (datagram.length - offset < 13)
            throw new InvalidRecord('Truncated DTLS record');
        const size = datagram.readUInt16BE(offset + 11);
        const end = offset + 13 + size;
        if (end > datagram.length || size > MAX_CIPHERTEXT || records.length === 128) {
            throw new InvalidRecord('Invalid DTLS record length');
        }
        const version = datagram.readUInt16BE(offset + 1);
        const epoch = datagram.readUInt16BE(offset + 3);
        if (version !== DTLS_12 && (version !== DTLS_10 || epoch !== 0)) {
            throw new InvalidRecord('Unexpected DTLS record version');
        }
        records.push({
            kind: datagram[offset], version, epoch,
            sequence: datagram.readUIntBE(offset + 5, 6),
            data: datagram.subarray(offset + 13, end),
        });
        offset = end;
    }
    return records;
}
function associatedData(record, size) {
    const data = Buffer.alloc(13);
    data.writeUInt16BE(record.epoch);
    data.writeUIntBE(record.sequence, 2, 6);
    data[8] = record.kind;
    data.writeUInt16BE(record.version, 9);
    data.writeUInt16BE(size, 11);
    return data;
}
function extension(kind, data = Buffer.alloc(0)) {
    return Buffer.concat([u16(kind), vector16(data)]);
}
function clientHello(random) {
    const groups = Buffer.concat([29, 23, 30, 25, 24].map(u16));
    const signatures = Buffer.concat([
        0x0403, 0x0503, 0x0603, 0x0807, 0x0808, 0x0809, 0x080a, 0x080b,
        0x0804, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0303, 0x0301,
        0x0302, 0x0402, 0x0502, 0x0602,
    ].map(u16));
    const extensions = Buffer.concat([
        extension(11, Buffer.from([3, 0, 1, 2])), // EC point formats
        extension(10, vector16(groups)),
        extension(35), // session ticket, with no resumption state
        extension(22), // encrypt-then-MAC
        extension(23), // extended master secret
        extension(13, vector16(signatures)),
    ]);
    const suites = Buffer.concat([AES_CBC, CHACHA, 0xff].map(u16));
    return message(1, 0, Buffer.concat([
        u16(DTLS_12), random, Buffer.alloc(2), vector16(suites),
        Buffer.from([1, 0]), vector16(extensions),
    ]));
}
function serverHello(body) {
    if (body.length < 40 || body.readUInt16BE() !== DTLS_12 || body[34] > 32) {
        throw new DtlsError('Invalid DTLS ServerHello');
    }
    const selection = 35 + body[34];
    if (body.length < selection + 5 || body[selection + 2] !== 0) {
        throw new DtlsError('Invalid DTLS cipher or compression selection');
    }
    const suite = body.readUInt16BE(selection);
    if (suite !== AES_CBC && suite !== CHACHA)
        throw new DtlsError('Unsupported DTLS cipher suite');
    const start = selection + 5;
    if (body.readUInt16BE(start - 2) !== body.length - start) {
        throw new DtlsError('Invalid DTLS ServerHello extensions');
    }
    const extensions = new Map();
    for (let offset = start; offset < body.length;) {
        if (body.length - offset < 4)
            throw new DtlsError('Truncated DTLS ServerHello extension');
        const kind = body.readUInt16BE(offset);
        const end = offset + 4 + body.readUInt16BE(offset + 2);
        if (end > body.length || extensions.has(kind))
            throw new DtlsError('Invalid DTLS ServerHello extension');
        extensions.set(kind, body.subarray(offset + 4, end));
        offset = end;
    }
    if (extensions.get(23)?.length !== 0 || (suite === AES_CBC && extensions.get(22)?.length !== 0)) {
        throw new DtlsError('Required DTLS cipher protections were not negotiated');
    }
    if (extensions.get(35)?.length)
        throw new DtlsError('Invalid DTLS ticket extension');
    return { suite, random: body.subarray(2, 34), ticketExpected: extensions.has(35) };
}
class RecordKeys {
    constructor(key, mac, iv) {
        this.key = key;
        this.mac = mac;
        this.iv = iv;
    }
    nonce(item) {
        const nonce = Buffer.from(this.iv);
        const aad = associatedData(item, 0);
        for (let index = 0; index < 8; index += 1)
            nonce[4 + index] ^= aad[index];
        return nonce;
    }
    seal(item) {
        if (!this.mac.length) {
            const cipher = createCipheriv('chacha20-poly1305', this.key, this.nonce(item), { authTagLength: 16 });
            cipher.setAAD(associatedData(item, item.data.length), { plaintextLength: item.data.length });
            return Buffer.concat([cipher.update(item.data), cipher.final(), cipher.getAuthTag()]);
        }
        const padSize = 16 - item.data.length % 16;
        const iv = randomBytes(16);
        const cipher = createCipheriv('aes-256-cbc', this.key, iv);
        cipher.setAutoPadding(false);
        const padded = Buffer.concat([item.data, Buffer.alloc(padSize, padSize - 1)]);
        const fragment = Buffer.concat([iv, cipher.update(padded), cipher.final()]);
        const tag = createHmac('sha384', this.mac).update(associatedData(item, fragment.length)).update(fragment).digest();
        return Buffer.concat([fragment, tag]);
    }
    open(item) {
        if (!this.mac.length) {
            const plaintextLength = item.data.length - 16;
            if (plaintextLength < 0 || plaintextLength > MAX_PLAINTEXT)
                throw new InvalidRecord('Invalid DTLS AEAD length');
            const cipher = createDecipheriv('chacha20-poly1305', this.key, this.nonce(item), { authTagLength: 16 });
            cipher.setAAD(associatedData(item, plaintextLength), { plaintextLength });
            cipher.setAuthTag(item.data.subarray(plaintextLength));
            try {
                return Buffer.concat([cipher.update(item.data.subarray(0, plaintextLength)), cipher.final()]);
            }
            catch (error) {
                if (!(error instanceof Error))
                    throw error;
                throw new InvalidRecord('Invalid DTLS record authentication');
            }
        }
        const fragment = item.data.subarray(0, Math.max(0, item.data.length - 48));
        if (fragment.length < 32 || fragment.length % 16 !== 0)
            throw new InvalidRecord('Invalid DTLS CBC length');
        const expected = createHmac('sha384', this.mac).update(associatedData(item, fragment.length)).update(fragment).digest();
        if (!timingSafeEqual(expected, item.data.subarray(fragment.length))) {
            throw new InvalidRecord('Invalid DTLS record authentication');
        }
        const cipher = createDecipheriv('aes-256-cbc', this.key, fragment.subarray(0, 16));
        cipher.setAutoPadding(false);
        const padded = Buffer.concat([cipher.update(fragment.subarray(16)), cipher.final()]);
        const padSize = padded[padded.length - 1] + 1;
        if (padSize > padded.length || !timingSafeEqual(padded.subarray(-padSize), Buffer.alloc(padSize, padSize - 1))) {
            throw new InvalidRecord('Invalid DTLS record padding');
        }
        const plain = padded.subarray(0, -padSize);
        if (plain.length > MAX_PLAINTEXT)
            throw new InvalidRecord('Invalid DTLS plaintext length');
        return plain;
    }
    clear() {
        this.key.fill(0);
        this.mac.fill(0);
        this.iv.fill(0);
    }
}
class Session {
    constructor(transport, deadline, signal) {
        this.transport = transport;
        this.deadline = deadline;
        this.cancellation = new AbortController();
        this.cancelFromCaller = () => this.close();
        this.records = [];
        this.next = 1;
        this.highest = -1;
        this.seen = 0n;
        this.reading = false;
        signal?.throwIfAborted();
        this.callerSignal = signal;
        signal?.addEventListener('abort', this.cancelFromCaller, { once: true });
    }
    live() {
        this.cancellation.signal.throwIfAborted();
        if (!this.transport)
            throw new DtlsError('DTLS session is closed');
        if (performance.now() >= this.deadline)
            throw new DeadlineExpired('DTLS deadline expired');
        return this.transport;
    }
    async wait(deadline, operation) {
        this.live();
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw new DeadlineExpired('DTLS deadline expired');
        const controller = new AbortController();
        const owner = this.cancellation.signal;
        const abort = () => controller.abort(owner.reason);
        owner.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DeadlineExpired('DTLS deadline expired')), Math.min(2147483647, Math.ceil(remaining)));
        let onAbort;
        try {
            const cancelled = new Promise((_, reject) => {
                onAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            return await Promise.race([cancelled, Promise.resolve().then(() => {
                    controller.signal.throwIfAborted();
                    if (performance.now() >= deadline)
                        throw new DeadlineExpired('DTLS deadline expired');
                    return operation(controller.signal);
                })]);
        }
        finally {
            if (onAbort)
                controller.signal.removeEventListener('abort', onAbort);
            clearTimeout(timer);
            owner.removeEventListener('abort', abort);
        }
    }
    async sendDatagram(data, sequence, deadline = this.deadline) {
        const transport = this.live();
        // IOTC keeps an independent 16-bit counter and a zero outer epoch even
        // for protected epoch-1 DTLS records.
        await this.wait(deadline, (signal) => transport.send(data, 0, sequence & 0xffff, signal));
        this.live();
        if (performance.now() >= deadline)
            throw new DeadlineExpired('DTLS deadline expired');
    }
    async readRecord(deadline) {
        deadline = Math.min(deadline, this.deadline);
        while (performance.now() < deadline) {
            const transport = this.live();
            const ready = this.records.shift();
            if (ready)
                return ready;
            let data;
            try {
                data = await this.wait(deadline, (signal) => transport.receive(deadline, signal));
            }
            catch (error) {
                if (error instanceof DeadlineExpired)
                    return undefined;
                throw error;
            }
            if (data === undefined || performance.now() >= deadline)
                return undefined;
            this.live();
            this.records = decodeRecords(data);
        }
        return undefined;
    }
    async handshake(password, deadline, sendProbe) {
        const psk = pskFromPassword(password);
        try {
            await this.authenticate(psk, deadline, sendProbe);
        }
        finally {
            psk.fill(0);
        }
    }
    async authenticate(psk, deadline, sendProbe) {
        const clientRandom = randomBytes(32);
        const hello = clientHello(clientRandom);
        const firstFlight = record(HANDSHAKE, 0, 0, hello, DTLS_10);
        await this.sendDatagram(firstFlight, 0, deadline);
        await this.sendDatagram(firstFlight, 0, deadline);
        if (sendProbe)
            await this.wait(deadline, sendProbe);
        // Repeat only the identical initial datagram before any peer reply.
        // Never repeat the key exchange or an application operation.
        const received = new Map();
        for (let attempt = 0; attempt < 3 && received.size < 3; attempt += 1) {
            if (attempt > 0 && performance.now() >= deadline)
                break;
            if (attempt > 0 && !received.size)
                await this.sendDatagram(firstFlight, 0, deadline);
            const until = Math.min(deadline, performance.now() + 1000);
            while (received.size < 3) {
                const incoming = await this.readRecord(until);
                if (!incoming)
                    break;
                if (incoming.kind !== HANDSHAKE || incoming.epoch !== 0) {
                    throw new DtlsError('Unexpected DTLS server hello flight');
                }
                for (const entry of messages(incoming.data)) {
                    if (entry.kind !== [2, 12, 14][entry.number])
                        throw new DtlsError('Unexpected DTLS server hello message');
                    const previous = received.get(entry.number);
                    if (previous && !previous.wire.equals(entry.wire))
                        throw new DtlsError('Conflicting DTLS server hello messages');
                    received.set(entry.number, entry);
                }
            }
        }
        const serverHelloMessage = received.get(0);
        const serverKeyMessage = received.get(1);
        const serverHelloDone = received.get(2);
        if (!serverHelloMessage || !serverKeyMessage || !serverHelloDone || serverHelloDone.body.length) {
            throw new DtlsError('Incomplete DTLS server hello flight');
        }
        const { suite, random: serverRandom, ticketExpected } = serverHello(serverHelloMessage.body);
        const serverKey = serverKeyMessage.body;
        if (serverKey.length !== 38 || !serverKey.subarray(0, 6).equals(X25519_PARAMS)) {
            throw new DtlsError('Unsupported DTLS server key exchange');
        }
        const { privateKey, publicKey } = generateKeyPairSync('x25519');
        let shared;
        try {
            const peerKey = createPublicKey({
                key: Buffer.concat([X25519_PUBLIC_DER, serverKey.subarray(6)]),
                type: 'spki', format: 'der',
            });
            shared = diffieHellman({ privateKey, publicKey: peerKey });
        }
        catch {
            throw new DtlsError('Invalid DTLS X25519 public key');
        }
        const clientKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(X25519_PUBLIC_DER.length);
        const exchange = message(16, 1, Buffer.concat([vector16(IDENTITY), Buffer.from([clientKey.length]), clientKey]));
        const transcript = Buffer.concat([hello, serverHelloMessage.wire, serverKeyMessage.wire, serverHelloDone.wire, exchange]);
        const digest = suite === AES_CBC ? 'sha384' : 'sha256';
        const premaster = Buffer.concat([vector16(shared), vector16(psk)]);
        shared.fill(0);
        const master = prf(digest, premaster, 'extended master secret', createHash(digest).update(transcript).digest(), 48);
        premaster.fill(0);
        try {
            await this.completeHandshake(master, transcript, exchange, clientRandom, serverRandom, digest, ticketExpected, received, deadline);
        }
        finally {
            master.fill(0);
        }
    }
    async completeHandshake(master, transcript, exchange, clientRandom, serverRandom, digest, ticketExpected, firstFlight, deadline) {
        const keyBlock = prf(digest, master, 'key expansion', Buffer.concat([serverRandom, clientRandom]), digest === 'sha384' ? 160 : 88);
        const empty = Buffer.alloc(0);
        if (digest === 'sha384') {
            this.tx = new RecordKeys(keyBlock.subarray(96, 128), keyBlock.subarray(0, 48), empty);
            this.rx = new RecordKeys(keyBlock.subarray(128, 160), keyBlock.subarray(48, 96), empty);
        }
        else {
            this.tx = new RecordKeys(keyBlock.subarray(0, 32), empty, keyBlock.subarray(64, 76));
            this.rx = new RecordKeys(keyBlock.subarray(32, 64), empty, keyBlock.subarray(76, 88));
        }
        const verify = prf(digest, master, 'client finished', createHash(digest).update(transcript).digest(), 12);
        const finished = message(20, 2, verify);
        await this.sendDatagram(Buffer.concat([
            record(HANDSHAKE, 0, 1, exchange),
            record(CHANGE_CIPHER, 0, 2, Buffer.from([1])),
            this.seal(HANDSHAKE, 0, finished),
        ]), 1, deadline);
        let ticket;
        let sawCcs = false;
        let peerFinished;
        const until = Math.min(deadline, performance.now() + 4000);
        for (let incoming = await this.readRecord(until); incoming; incoming = await this.readRecord(until)) {
            if (incoming.kind === CHANGE_CIPHER && incoming.epoch === 0 && incoming.data.length === 1 && incoming.data[0] === 1) {
                sawCcs = true;
            }
            else if (incoming.kind === HANDSHAKE && incoming.epoch === 1 && incoming.sequence === 0) {
                if (peerFinished && !peerFinished.data.equals(incoming.data))
                    throw new DtlsError('Conflicting DTLS Finished records');
                peerFinished = incoming;
            }
            else if (incoming.kind === HANDSHAKE && incoming.epoch === 0) {
                for (const entry of messages(incoming.data)) {
                    if (firstFlight.get(entry.number)?.wire.equals(entry.wire))
                        continue;
                    if (!ticketExpected || entry.kind !== 4 || entry.number !== 3 || entry.body.length < 6) {
                        throw new DtlsError('Unexpected DTLS final handshake message');
                    }
                    if (entry.body.readUInt16BE(4) !== entry.body.length - 6 || (ticket && !ticket.equals(entry.wire))) {
                        throw new DtlsError('Invalid DTLS session ticket message');
                    }
                    ticket = entry.wire;
                }
            }
            else {
                throw new DtlsError('Unexpected DTLS final handshake flight');
            }
            if (sawCcs && peerFinished && (ticket || !ticketExpected)) {
                this.live();
                if (!this.rx)
                    throw new DtlsError('DTLS session is closed');
                const plain = this.rx.open(peerFinished);
                const sessionHash = createHash(digest).update(transcript).update(finished).update(ticket ?? empty).digest();
                const expected = message(20, ticket ? 4 : 3, prf(digest, master, 'server finished', sessionHash, 12));
                if (plain.length !== expected.length || !timingSafeEqual(plain, expected)) {
                    throw new DtlsError('DTLS server authentication failed');
                }
                this.highest = 0;
                this.seen = 1n;
                return;
            }
        }
        throw new DtlsError('Incomplete DTLS Finished flight');
    }
    seal(kind, sequence, data) {
        if (!this.tx)
            throw new DtlsError('DTLS session is closed');
        return record(kind, 1, sequence, this.tx.seal({ kind, version: DTLS_12, epoch: 1, sequence, data }));
    }
    async send(data) {
        if (!data.length || data.length > MAX_PLAINTEXT || this.next >= MAX_SEQUENCE) {
            throw new DtlsError('Invalid DTLS send length or sequence');
        }
        try {
            this.live();
            const sequence = this.next++;
            await this.sendDatagram(this.seal(APPLICATION, sequence, data), sequence + 1);
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    accept(item) {
        if (item.epoch !== 1 || !this.rx)
            return undefined;
        const shift = this.highest - item.sequence;
        if (shift >= REPLAY_WINDOW || (shift >= 0 && (this.seen & (1n << BigInt(shift))) !== 0n))
            return undefined;
        if (item.kind !== APPLICATION && item.kind !== ALERT)
            return undefined;
        const data = this.rx.open(item); // An unverified sequence must never move the window.
        if (shift < 0) {
            this.seen = (shift > -REPLAY_WINDOW ? (this.seen << BigInt(-shift)) & REPLAY_MASK : 0n) | 1n;
            this.highest = item.sequence;
        }
        else {
            this.seen |= 1n << BigInt(shift);
        }
        if (item.kind === ALERT)
            throw new DtlsError('The DTLS peer closed the session');
        return data;
    }
    async receive(deadline) {
        this.live();
        if (!Number.isFinite(deadline) || this.reading)
            throw new DtlsError('Invalid or concurrent DTLS receive');
        this.reading = true;
        try {
            for (;;) {
                try {
                    const incoming = await this.readRecord(deadline);
                    if (!incoming)
                        return undefined;
                    const data = this.accept(incoming);
                    if (data)
                        return data;
                }
                catch (error) {
                    if (!(error instanceof InvalidRecord))
                        throw error;
                }
            }
        }
        catch (error) {
            this.close();
            throw error;
        }
        finally {
            this.reading = false;
        }
    }
    close() {
        this.callerSignal?.removeEventListener('abort', this.cancelFromCaller);
        this.callerSignal = undefined;
        this.transport = undefined;
        this.tx?.clear();
        this.rx?.clear();
        this.tx = this.rx = undefined;
        this.records = [];
        this.cancellation.abort(new DtlsError('DTLS session is closed'));
    }
}
/** Authenticate a peer over a selected IOTC path. The caller owns that path. */
export async function connectDtls(transport, password, options) {
    const now = performance.now();
    const timeout = options.handshakeTimeoutMs ?? 15000;
    if (!Number.isFinite(options.deadline) || options.deadline <= now || !Number.isFinite(timeout) || timeout <= 0) {
        throw new DeadlineExpired('Invalid DTLS deadline');
    }
    const handshakeDeadline = Math.min(options.deadline, now + timeout);
    const session = new Session(transport, options.deadline, options.signal);
    try {
        await session.handshake(password, handshakeDeadline, options.sendProbe);
        options.signal?.throwIfAborted();
        if (performance.now() >= handshakeDeadline)
            throw new DeadlineExpired('DTLS handshake deadline expired');
        return session;
    }
    catch (error) {
        session.close();
        throw error;
    }
}
