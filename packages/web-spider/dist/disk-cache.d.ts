/**
 * Disk-backed cache implementing ICache<string, SpideredPage>.
 *
 * Persists to a JSON file so the cache survives extension reloads and
 * pi restarts. Call flush() to write — set() auto-flushes by default.
 *
 * The images directory is derived automatically from `dirname(path)/images`.
 * Callers do not need to create it — DiskCache creates it on first large-image
 * flush. Pre-creating it at startup (e.g. in the extension boot path) is
 * harmless and avoids a first-write delay.
 *
 * Internal storage uses a plain object (Object.create(null)) rather than a
 * Map. Plain objects carry no realm-specific internal slots, making them safe
 * across V8 context (realm) boundaries — e.g. when DiskCache is constructed
 * in an ESM module realm but called from a jiti VM-sandbox realm (Bun binary
 * mode). The Map-backed version threw "Map operation called on non-Map object"
 * in that scenario.
 *
 * A schema version field in the persisted JSON guards against stale cache
 * files from previous major versions being silently loaded with wrong shapes.
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
    /**
     * Base64 byte threshold for inline vs. file storage of images.
     * Images whose base64 string length exceeds this are written as binary
     * files to <cache-dir>/images/ instead of being stored inline in the JSON.
     * Default: 32 * 1024 (32 KB of base64 ≈ 24 KB binary).
     */
    inlineImageThreshold?: number;
}
export declare class DiskCache implements ICache<string, SpideredPage> {
    private readonly store;
    private readonly path;
    private readonly ttlMs;
    private readonly maxSize;
    private readonly autoFlush;
    private readonly inlineImageThreshold;
    /** Directory where large image binaries are stored. */
    private readonly imagesDir;
    constructor(path: string, opts?: DiskCacheOptions);
    private key;
    set(url: string, page: SpideredPage): void;
    has(url: string): boolean;
    delete(url: string): void;
    /** Derive a stable filename for an image binary from its src URL. */
    private imageFilename;
    /**
     * Prepare images for serialisation:
     * - Images whose base64 length ≤ threshold are kept inline.
     * - Larger images are written to imagesDir as binary files; base64 is
     *   replaced by filePath in the serialised entry.
     */
    private spill;
    /**
     * Hydrate images on read: if an image has filePath but no base64,
     * load the binary from disk and re-encode.
     */
    private hydrate;
    /** Write current contents to disk. Large images are spilled to imagesDir. */
    flush(): void;
    private load;
    /** All currently valid (non-expired) pages, sorted newest-first. */
    values(): SpideredPage[];
    /** Retrieve a page, hydrating any file-backed images from disk. */
    get(url: string): SpideredPage | undefined;
}
//# sourceMappingURL=disk-cache.d.ts.map