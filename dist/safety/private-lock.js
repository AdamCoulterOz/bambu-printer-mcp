import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { constants } from 'node:fs';
import { join } from 'node:path';
/** Stable inode, OS-released after process death. No stale PID leases. */
export async function withPrivateLock(directory, fn, signal, onAcquired) {
    signal?.throwIfAborted();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid()))
        throw new Error('Private state directory must be private and owned by the current user.');
    const handle = await fs.open(join(directory, '.state.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        await handle.close();
        throw new Error('Private state lock unavailable.');
    }
    const code = `import fcntl,os,stat,sys
f=3
s=os.fstat(f)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_mode&0o077 or s.st_nlink!=1: sys.exit(1)
fcntl.flock(f,fcntl.LOCK_EX)
t=os.stat(sys.argv[1],follow_symlinks=False)
if (s.st_dev,s.st_ino)!=(t.st_dev,t.st_ino): sys.exit(1)
sys.stdout.write('READY\\n');sys.stdout.flush()
sys.stdin.buffer.read()
`;
    const child = spawn('python3', ['-c', code, join(directory, '.state.lock')], { stdio: ['pipe', 'pipe', 'pipe', handle.fd] });
    const input = child.stdin, output = child.stdout, errors = child.stderr;
    input.on('error', () => { });
    errors.resume();
    const exited = new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    try {
        await new Promise((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => finish(false), 30000);
            const cancel = () => finish(false);
            const finish = (ok) => { if (done)
                return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (ok)
                resolve();
            else {
                child.kill('SIGKILL');
                reject(new Error('Private state lock unavailable; Python 3 with POSIX fcntl is required.'));
            } };
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted)
                return cancel();
            let ready = '';
            output.on('data', data => { ready += data.toString(); if (ready.length > 6)
                finish(false);
            else if (ready === 'READY\n')
                finish(true); });
            child.once('error', () => finish(false));
            child.once('exit', () => finish(false));
        });
        signal?.throwIfAborted();
        if (child.pid && onAcquired)
            onAcquired(child.pid);
        return await fn();
    }
    finally {
        input.end();
        await exited;
        await handle.close();
    }
}
