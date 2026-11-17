import { get } from 'node:https';
export declare const REVIEWED_APK_URL = "https://public-cdn.bblmw.cn/upgrade/app/software/4.4.1/app_zh_release.apk";
/** Test seam accepts synthetic response/bytes only; production fixes host and pin. */
export declare function downloadReviewedPackageForTest(path: string, options?: {
    signal?: AbortSignal;
    transport?: typeof get;
    size?: number;
    sha256?: string;
    deadlineMs?: number;
}): Promise<void>;
