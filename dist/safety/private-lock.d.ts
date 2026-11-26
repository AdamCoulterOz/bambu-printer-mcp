/** Stable inode, OS-released after process death. No stale PID leases. */
export declare function withPrivateLock<T>(directory: string, fn: () => Promise<T>, signal?: AbortSignal, onAcquired?: (pid: number) => void): Promise<T>;
/** Probe the stable inode without waiting. A held lock is a live owner. */
export declare function privateLockHeld(directory: string): Promise<boolean>;
