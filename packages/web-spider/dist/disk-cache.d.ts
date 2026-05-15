/**
 * Disk-backed cache implementing ICache<string, SpideredPage>.
 *
 * Persists to a JSON file so the cache survives extension reloads and
 * pi restarts. Call flush() to write — set() auto-flushes by default.
 */
import type { ICache } from "./ports.js";
import type { SpideredPage } from "./types.js";
export interface DiskCacheOptions {
    /** Time-to-live in ms. Default 30 min. */
    ttlMs?: number;
    /** Max entries. Default 500. */
    maxSize?: number;
    /** Auto-flush to disk on every set(). Default true. */
    autoFlush?: boolean;
}
export declare class DiskCache implements ICache<string, SpideredPage> {
    private readonly store;
    private readonly path;
    private readonly ttlMs;
    private readonly maxSize;
    private readonly autoFlush;
    constructor(path: string, opts?: DiskCacheOptions);
    private key;
    get(url: string): SpideredPage | undefined;
    set(url: string, page: SpideredPage): void;
    has(url: string): boolean;
    delete(url: string): void;
    /** Write current contents to disk. */
    flush(): void;
    private load;
}
//# sourceMappingURL=disk-cache.d.ts.map