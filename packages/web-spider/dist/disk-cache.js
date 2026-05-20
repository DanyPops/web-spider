/**
 * Disk-backed cache implementing ICache<string, SpideredPage>.
 *
 * Persists to a JSON file so the cache survives extension reloads and
 * pi restarts. Call flush() to write — set() auto-flushes by default.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
export class DiskCache {
    constructor(path, opts = {}) {
        this.store = new Map();
        this.path = path;
        this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
        this.maxSize = opts.maxSize ?? 500;
        this.autoFlush = opts.autoFlush ?? true;
        this.inlineImageThreshold = opts.inlineImageThreshold ?? 32 * 1024;
        this.imagesDir = join(dirname(path), "images");
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
    // ---------------------------------------------------------------------------
    // Image helpers
    // ---------------------------------------------------------------------------
    /** Derive a stable filename for an image binary from its src URL. */
    imageFilename(src) {
        const hash = createHash("sha1").update(src).digest("hex");
        const ext = extname(src.split("?")[0]) || ".bin";
        return `${hash}${ext}`;
    }
    /**
     * Prepare images for serialisation:
     * - Images whose base64 length ≤ threshold are kept inline.
     * - Larger images are written to imagesDir as binary files; base64 is
     *   replaced by filePath in the serialised entry.
     */
    spill(images) {
        if (!existsSync(this.imagesDir)) {
            mkdirSync(this.imagesDir, { recursive: true });
        }
        return images.map((img) => {
            if (!img.base64 || img.base64.length <= this.inlineImageThreshold) {
                return img; // keep inline
            }
            const filename = this.imageFilename(img.src);
            const filePath = join(this.imagesDir, filename);
            writeFileSync(filePath, Buffer.from(img.base64, "base64"));
            // Return without base64 — only filePath stored in JSON.
            const { base64: _omit, ...rest } = img;
            return { ...rest, filePath };
        });
    }
    /**
     * Hydrate images on read: if an image has filePath but no base64,
     * load the binary from disk and re-encode.
     */
    hydrate(images) {
        return images.map((img) => {
            if (img.base64 || !img.filePath)
                return img;
            if (!existsSync(img.filePath))
                return img; // file missing — degrade gracefully
            try {
                const base64 = readFileSync(img.filePath).toString("base64");
                return { ...img, base64 };
            }
            catch {
                return img;
            }
        });
    }
    // ---------------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------------
    /** Write current contents to disk. Large images are spilled to imagesDir. */
    flush() {
        const now = Date.now();
        const entries = {};
        for (const [k, v] of this.store) {
            if (v.expiresAt <= now)
                continue;
            const page = v.page;
            const serialised = page.images
                ? { ...page, images: this.spill(page.images) }
                : page;
            entries[k] = { page: serialised, expiresAt: v.expiresAt };
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
    /** All currently valid (non-expired) pages, sorted newest-first. */
    values() {
        const now = Date.now();
        return [...this.store.values()]
            .filter((e) => e.expiresAt > now)
            .sort((a, b) => b.expiresAt - a.expiresAt)
            .map((e) => {
            const page = e.page;
            return page.images ? { ...page, images: this.hydrate(page.images) } : page;
        });
    }
    /** Retrieve a page, hydrating any file-backed images from disk. */
    get(url) {
        const k = this.key(url);
        const entry = this.store.get(k);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(k);
            return undefined;
        }
        const page = entry.page;
        if (page.images)
            return { ...page, images: this.hydrate(page.images) };
        return page;
    }
}
//# sourceMappingURL=disk-cache.js.map