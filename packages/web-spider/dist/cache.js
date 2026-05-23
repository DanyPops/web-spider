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
export class SpiderCache {
    constructor(opts = {}) {
        this.store = Object.create(null);
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
        const entry = this.store[k];
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            delete this.store[k];
            return undefined;
        }
        // Promote to tail (most-recently-used) by delete + reinsert.
        // Object insertion order is preserved for string keys in ES2015+.
        delete this.store[k];
        this.store[k] = entry;
        return entry.page;
    }
    set(url, page) {
        const k = this.key(url);
        if (Object.keys(this.store).length >= this.maxSize && !(k in this.store)) {
            const lruKey = Object.keys(this.store)[0];
            if (lruKey !== undefined)
                delete this.store[lruKey];
        }
        this.store[k] = { page, expiresAt: Date.now() + this.ttlMs };
    }
    has(url) {
        return this.get(url) !== undefined;
    }
    delete(url) {
        delete this.store[this.key(url)];
    }
    clear() {
        for (const k of Object.keys(this.store))
            delete this.store[k];
    }
    get size() {
        return Object.keys(this.store).length;
    }
    /** All currently valid pages (does not update LRU order). */
    values() {
        const now = Date.now();
        return Object.values(this.store)
            .filter((e) => e !== undefined && e.expiresAt > now)
            .map((e) => e.page);
    }
}
//# sourceMappingURL=cache.js.map