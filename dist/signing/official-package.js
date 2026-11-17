/** Optional fixed-source acquisition. The reviewed APK is treated as data and
 * never executed. SHA-256 and size are independently checked before extraction. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { get } from 'node:https';
import { SigningError } from './pki.js';
export const REVIEWED_APK_URL = 'https://public-cdn.bblmw.cn/upgrade/app/software/4.4.1/app_zh_release.apk';
const REVIEWED_APK_SIZE = 185964655;
const REVIEWED_APK_SHA256 = '88548d4d993741e95727d1675e8d997bb92586f732f1ef72ada0281921f76506';
/** Test seam accepts synthetic response/bytes only; production fixes host and pin. */
export async function downloadReviewedPackageForTest(path, options = {}) {
    let created = false;
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.deadlineMs ?? 600000)]);
    try {
        signal.throwIfAborted();
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        try {
            const response = await new Promise((resolve, reject) => {
                const req = (options.transport ?? get)(REVIEWED_APK_URL, { headers: { 'Accept-Encoding': 'identity' }, agent: false, signal, timeout: 60000 }, resolve);
                req.on('timeout', () => req.destroy());
                req.on('error', reject);
            });
            if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity')) {
                response.destroy();
                throw new Error();
            }
            const maximum = options.size ?? REVIEWED_APK_SIZE;
            const hash = createHash('sha256');
            let count = 0;
            for await (const chunk of response) {
                signal.throwIfAborted();
                if (!Buffer.isBuffer(chunk))
                    throw new Error();
                count += chunk.length;
                if (count > maximum)
                    throw new Error();
                hash.update(chunk);
                await file.writeFile(chunk);
            }
            signal.throwIfAborted();
            if (count !== maximum || hash.digest('hex') !== (options.sha256 ?? REVIEWED_APK_SHA256))
                throw new Error();
            await file.sync();
        }
        finally {
            await file.close();
        }
    }
    catch {
        if (created)
            await unlink(path).catch(() => { });
        throw new SigningError('SIGNING_PACKAGE_ACQUISITION_FAILED');
    }
}
