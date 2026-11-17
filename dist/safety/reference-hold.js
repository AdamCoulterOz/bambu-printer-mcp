import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, writeFileSync, readFileSync, lstatSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { withPrivateLock } from './private-lock.js';
function directory(serial) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serial))
        throw new Error('A printer serial is required.');
    const root = process.env.BAMBU_RESUME_STATE_DIR || join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'), 'bambu-printer-mcp', 'resume');
    return join(root, 'reference-holds', createHash('sha256').update(serial.toUpperCase()).digest('hex'));
}
function syncDir(dir) { const fd = openSync(dir, constants.O_RDONLY); try {
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} }
function read(dir, serial) {
    const file = join(dir, 'hold.json');
    try {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()) || st.size > 2048)
            throw new Error();
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (value.version !== 1 || value.serial !== serial.toUpperCase() || !/^[-a-f0-9]{36}$/.test(value.nonce) || !Number.isSafeInteger(value.created) || value.created < 0 || value.taskId !== undefined && !/^[1-9]\d{0,19}$/.test(value.taskId))
            throw new Error();
        return value;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return undefined;
        throw new Error('Printer reference hold is unavailable or invalid; manual recovery is required.');
    }
}
function write(dir, hold) {
    const temp = join(dir, `.hold-${randomUUID()}`);
    let fd;
    try {
        fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, JSON.stringify(hold));
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, join(dir, 'hold.json'));
        syncDir(dir);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(temp);
        }
        catch { }
    }
}
function remove(dir) { try {
    unlinkSync(join(dir, 'hold.json'));
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
} syncDir(dir); }
/** The OS lock serializes starts across processes sharing this private state. */
export async function withPrintStartGuard(serial, fn) {
    const dir = directory(serial);
    return withPrivateLock(dir, async () => { if (read(dir, serial))
        throw new Error('A previous reference print remains pending or uncertain; inspect printer and history before recovery.'); return fn(); });
}
/** Call under withPrintStartGuard, synchronously before transport handoff. */
export function markReferenceUnknown(serial) { const dir = directory(serial); if (read(dir, serial))
    throw new Error('A previous reference print remains pending or uncertain.'); const nonce = randomUUID(); write(dir, { version: 1, serial: serial.toUpperCase(), nonce, created: Date.now() }); return nonce; }
export function discardUnsentReferenceHold(serial, nonce) { const dir = directory(serial), hold = read(dir, serial); if (!hold || hold.nonce !== nonce || hold.taskId)
    throw new Error('Reference hold changed before dispatch.'); remove(dir); }
/** Call under the same print guard; failure leaves the durable unknown hold. */
export function bindReferenceTask(serial, id) { const dir = directory(serial), hold = read(dir, serial); if (!hold || hold.taskId || !/^[1-9]\d{0,19}$/.test(id))
    throw new Error('Reference hold cannot be bound.'); write(dir, { ...hold, taskId: id }); }
export async function inspectReferenceHold(serial) {
    const dir = directory(serial);
    return withPrivateLock(dir, async () => { const h = read(dir, serial); return !h ? { state: 'none' } : h.taskId ? { state: 'pending', taskId: h.taskId, nonce: h.nonce } : { state: 'unknown', nonce: h.nonce }; });
}
/** Caller supplies a fresh observed-serial report acquired without holding this lock. */
export async function observeReferenceHold(serial, status) {
    const dir = directory(serial);
    return withPrivateLock(dir, async () => {
        const hold = read(dir, serial);
        if (!hold)
            return 'none';
        if (!hold.taskId)
            return 'unknown';
        const o = status?.observation, raw = status?.raw, now = Date.now();
        if (status?.connected !== true || status.serial !== serial || o?.source !== 'mqtt' || !Number.isFinite(o.requestedAt) || !Number.isFinite(o.receivedAt) || o.requestedAt < hold.created || o.receivedAt < o.requestedAt || o.receivedAt > now || now - o.requestedAt > 15000 || !raw)
            throw new Error('A fresh observed printer report is required.');
        const task = typeof raw.task_id === 'string' ? raw.task_id : typeof raw.task_id === 'number' && Number.isSafeInteger(raw.task_id) ? String(raw.task_id) : '';
        if (task !== hold.taskId)
            return 'pending';
        // The collector does not expose a stable MQTT connection epoch. Even a
        // matching active-then-terminal sequence cannot prove both observations
        // belong to the same connection lifecycle, so retain the durable hold.
        return 'pending';
    });
}
/** Explicit human recovery checks the exact hold observed before confirmation. */
export async function clearReferenceHold(serial, nonce, withAuthority, signal) {
    const dir = directory(serial);
    await withPrivateLock(dir, async () => { const hold = read(dir, serial); if (!hold || hold.nonce !== nonce)
        throw new Error('Printer reference hold changed; review it again.'); signal?.throwIfAborted(); let removed = false; await withAuthority(() => { signal?.throwIfAborted(); remove(dir); removed = true; }); if (!removed)
        throw new Error('Printer reference hold was not cleared.'); }, signal);
}
