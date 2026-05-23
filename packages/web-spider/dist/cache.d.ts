import type { ICache } from "./ports.js";
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
 * Uses a plain object (Object.create(null)) for storage rather than a Map.
 * Plain objects carry no realm-specific internal slots, so they are safe
 * across V8 context (realm) boundaries — e.g. when the cache is constructed
 * in an ESM module realm but called from a jiti VM-sandbox realm.
 *
 * JavaScript objects maintain insertion order for string keys (ES2015+),
 * so delete-then-reinsert gives the same LRU-tail promotion semantics as a
 * Map without any cross-realm risk.
 */
export declare class SpiderCache implements ICache<string, SpideredPage> {
    private readonly store;
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