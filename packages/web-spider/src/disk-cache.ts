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
 * in that scenario (WBS-BUG-4).
 *
 * A schema version field in the persisted JSON guards against stale cache
 * files from previous major versions being silently loaded with wrong shapes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ICache } from "./ports.js";
import type { ImageRef, SpideredPage } from "./types.js";

/** Bump when the on-disk entry shape changes incompatibly. */
const SCHEMA_VERSION = 2;

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

interface Entry {
	page: SpideredPage;
	expiresAt: number;
}

/** Versioned wrapper written to disk. */
interface DiskPayload {
	v: number;
	entries: Record<string, Entry>;
}

export class DiskCache implements ICache<string, SpideredPage> {
	private readonly store: Record<string, Entry | undefined> = Object.create(null);
	private readonly path: string;
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly autoFlush: boolean;
	private readonly inlineImageThreshold: number;
	/** Directory where large image binaries are stored. */
	private readonly imagesDir: string;

	constructor(path: string, opts: DiskCacheOptions = {}) {
		this.path = path;
		this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
		this.maxSize = opts.maxSize ?? 500;
		this.autoFlush = opts.autoFlush ?? true;
		this.inlineImageThreshold = opts.inlineImageThreshold ?? 32 * 1024;
		this.imagesDir = join(dirname(path), "images");
		this.load();
	}

	private key(url: string): string {
		try {
			const u = new URL(url);
			u.hash = "";
			return u.toString().replace(/\/$/, "");
		} catch {
			return url;
		}
	}

	set(url: string, page: SpideredPage): void {
		const k = this.key(url);
		if (Object.keys(this.store).length >= this.maxSize && !(k in this.store)) {
			const oldest = Object.keys(this.store)[0];
			if (oldest !== undefined) delete this.store[oldest];
		}
		this.store[k] = { page, expiresAt: Date.now() + this.ttlMs };
		if (this.autoFlush) this.flush();
	}

	has(url: string): boolean {
		return this.get(url) !== undefined;
	}

	delete(url: string): void {
		delete this.store[this.key(url)];
		if (this.autoFlush) this.flush();
	}

	// ---------------------------------------------------------------------------
	// Image helpers
	// ---------------------------------------------------------------------------

	/** Derive a stable filename for an image binary from its src URL. */
	private imageFilename(src: string): string {
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
	private spill(images: ImageRef[]): ImageRef[] {
		if (!existsSync(this.imagesDir)) {
			mkdirSync(this.imagesDir, { recursive: true });
		}
		return images.map((img) => {
			if (!img.base64 || img.base64.length <= this.inlineImageThreshold) {
				return img;
			}
			const filename = this.imageFilename(img.src);
			const filePath = join(this.imagesDir, filename);
			writeFileSync(filePath, Buffer.from(img.base64, "base64"));
			const { base64: _omit, ...rest } = img;
			return { ...rest, filePath };
		});
	}

	/**
	 * Hydrate images on read: if an image has filePath but no base64,
	 * load the binary from disk and re-encode.
	 */
	private hydrate(images: ImageRef[]): ImageRef[] {
		return images.map((img) => {
			if (img.base64 || !img.filePath) return img;
			if (!existsSync(img.filePath)) return img;
			try {
				const base64 = readFileSync(img.filePath).toString("base64");
				return { ...img, base64 };
			} catch {
				return img;
			}
		});
	}

	// ---------------------------------------------------------------------------
	// Persistence
	// ---------------------------------------------------------------------------

	/** Write current contents to disk. Large images are spilled to imagesDir. */
	flush(): void {
		const now = Date.now();
		const entries: Record<string, Entry> = {};
		for (const [k, v] of Object.entries(this.store)) {
			if (!v || v.expiresAt <= now) continue;
			const page = v.page;
			const serialised: SpideredPage = page.images
				? { ...page, images: this.spill(page.images) }
				: page;
			entries[k] = { page: serialised, expiresAt: v.expiresAt };
		}
		const payload: DiskPayload = { v: SCHEMA_VERSION, entries };
		writeFileSync(this.path, JSON.stringify(payload), "utf8");
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;

			// Reject files from incompatible schema versions (including old
			// unversioned files that lack the "v" field entirely).
			if (
				typeof raw !== "object" ||
				raw === null ||
				(raw as { v?: unknown }).v !== SCHEMA_VERSION
			) {
				return; // stale schema — start fresh, do not throw
			}

			const payload = raw as DiskPayload;
			const now = Date.now();
			for (const [k, v] of Object.entries(payload.entries)) {
				if (v.expiresAt > now) this.store[k] = v;
			}
		} catch {
			// Corrupt or unreadable file — start fresh.
		}
	}

	/** All currently valid (non-expired) pages, sorted newest-first. */
	values(): SpideredPage[] {
		const now = Date.now();
		return Object.values(this.store)
			.filter((e): e is Entry => e !== undefined && e.expiresAt > now)
			.sort((a, b) => b.expiresAt - a.expiresAt)
			.map((e) => {
				const page = e.page;
				return page.images ? { ...page, images: this.hydrate(page.images) } : page;
			});
	}

	/** Retrieve a page, hydrating any file-backed images from disk. */
	get(url: string): SpideredPage | undefined {
		const k = this.key(url);
		const entry = this.store[k];
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			delete this.store[k];
			return undefined;
		}
		const page = entry.page;
		if (page.images) return { ...page, images: this.hydrate(page.images) };
		return page;
	}
}
