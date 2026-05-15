/**
 * Disk-backed cache implementing ICache<string, SpideredPage>.
 *
 * Persists to a JSON file so the cache survives extension reloads and
 * pi restarts. Call flush() to write — set() auto-flushes by default.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

interface Entry {
	page: SpideredPage;
	expiresAt: number;
}

export class DiskCache implements ICache<string, SpideredPage> {
	private readonly store = new Map<string, Entry>();
	private readonly path: string;
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly autoFlush: boolean;

	constructor(path: string, opts: DiskCacheOptions = {}) {
		this.path = path;
		this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
		this.maxSize = opts.maxSize ?? 500;
		this.autoFlush = opts.autoFlush ?? true;
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

	get(url: string): SpideredPage | undefined {
		const k = this.key(url);
		const entry = this.store.get(k);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.store.delete(k);
			return undefined;
		}
		return entry.page;
	}

	set(url: string, page: SpideredPage): void {
		const k = this.key(url);
		if (this.store.size >= this.maxSize && !this.store.has(k)) {
			const oldest = this.store.keys().next().value as string;
			this.store.delete(oldest);
		}
		this.store.set(k, { page, expiresAt: Date.now() + this.ttlMs });
		if (this.autoFlush) this.flush();
	}

	has(url: string): boolean {
		return this.get(url) !== undefined;
	}

	delete(url: string): void {
		this.store.delete(this.key(url));
		if (this.autoFlush) this.flush();
	}

	/** Write current contents to disk. */
	flush(): void {
		const now = Date.now();
		const entries: Record<string, Entry> = {};
		for (const [k, v] of this.store) {
			if (v.expiresAt > now) entries[k] = v;
		}
		writeFileSync(this.path, JSON.stringify(entries), "utf8");
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Entry>;
			const now = Date.now();
			for (const [k, v] of Object.entries(raw)) {
				if (v.expiresAt > now) this.store.set(k, v);
			}
		} catch {
			// Corrupt file — start fresh
		}
	}
}
