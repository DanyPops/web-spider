import type { SpideredPage } from "./types.js";
export interface SpiderCacheOptions {
    /** Maximum number of pages to hold (default 500) */
    maxSize?: number;
    /** Time-to-live in milliseconds (default 30 min) */
    ttlMs?: number;
}
/**
 * LRU cache for spidered pages.
 *
 * Implements the Identity Map pattern from Local Materialized View:
 * exactly one entry per normalised URL — duplicate fetches never happen.
 *
 * Uses a JS Map for O(1) get/set. Because Map preserves insertion order,
 * moving an entry to the tail on access gives LRU semantics with no
 * secondary data structure needed.
 */
export declare class SpiderCache {
    private readonly map;
    private readonly maxSize;
    private readonly ttlMs;
    constructor(opts?: SpiderCacheOptions);
    /** Normalise a URL so http/https and trailing slashes don't cause misses. */
    private key;
    get(url: string): SpideredPage | undefined;
    set(url: string, page: SpideredPage): void;
    has(url: string): boolean;
    delete(url: string): void;
    clear(): void;
    get size(): number;
    /** All currently valid pages (does not update LRU order). */
    values(): SpideredPage[];
}
//# sourceMappingURL=cache.d.ts.map