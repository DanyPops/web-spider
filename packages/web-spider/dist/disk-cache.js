/**
 * Disk-backed cache implementing ICache<string, SpideredPage>.
 *
 * Persists to a JSON file so the cache survives extension reloads and
 * pi restarts. Call flush() to write — set() auto-flushes by default.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
export class DiskCache {
    constructor(path, opts = {}) {
        this.store = new Map();
        this.path = path;
        this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
        this.maxSize = opts.maxSize ?? 500;
        this.autoFlush = opts.autoFlush ?? true;
        this.load();
    }
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
        const entry = this.store.get(k);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(k);
            return undefined;
        }
        return entry.page;
    }
    set(url, page) {
        const k = this.key(url);
        if (this.store.size >= this.maxSize && !this.store.has(k)) {
            const oldest = this.store.keys().next().value;
            this.store.delete(oldest);
        }
        this.store.set(k, { page, expiresAt: Date.now() + this.ttlMs });
        if (this.autoFlush)
            this.flush();
    }
    has(url) {
        return this.get(url) !== undefined;
    }
    delete(url) {
        this.store.delete(this.key(url));
        if (this.autoFlush)
            this.flush();
    }
    /** Write current contents to disk. */
    flush() {
        const now = Date.now();
        const entries = {};
        for (const [k, v] of this.store) {
            if (v.expiresAt > now)
                entries[k] = v;
        }
        writeFileSync(this.path, JSON.stringify(entries), "utf8");
    }
    load() {
        if (!existsSync(this.path))
            return;
        try {
            const raw = JSON.parse(readFileSync(this.path, "utf8"));
            const now = Date.now();
            for (const [k, v] of Object.entries(raw)) {
                if (v.expiresAt > now)
                    this.store.set(k, v);
            }
        }
        catch {
            // Corrupt file — start fresh
        }
    }
}
//# sourceMappingURL=disk-cache.js.map