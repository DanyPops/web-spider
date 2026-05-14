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
export class SpiderCache {
    constructor(opts = {}) {
        this.map = new Map();
        this.maxSize = opts.maxSize ?? 500;
        this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    }
    /** Normalise a URL so http/https and trailing slashes don't cause misses. */
    key(url) {
        try {
            const u = new URL(url);
            u.hash = "";
            return u.toString().replace(/\/$/, "");
        }
        catch {
            return url;
        }
    }
    get(url) {
        const k = this.key(url);
        const entry = this.map.get(k);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.map.delete(k);
            return undefined;
        }
        // Move to tail — most recently used
        this.map.delete(k);
        this.map.set(k, entry);
        return entry.page;
    }
    set(url, page) {
        const k = this.key(url);
        // Evict LRU (head of map) if at capacity
        if (this.map.size >= this.maxSize && !this.map.has(k)) {
            const lruKey = this.map.keys().next().value;
            this.map.delete(lruKey);
        }
        this.map.set(k, { page, expiresAt: Date.now() + this.ttlMs });
    }
    has(url) {
        return this.get(url) !== undefined;
    }
    delete(url) {
        this.map.delete(this.key(url));
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
    /** All currently valid pages (does not update LRU order). */
    values() {
        const now = Date.now();
        return [...this.map.values()].filter((e) => e.expiresAt > now).map((e) => e.page);
    }
}
//# sourceMappingURL=cache.js.map