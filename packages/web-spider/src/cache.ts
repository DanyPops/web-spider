import type { SpideredPage } from "./types.js";

interface CacheEntry {
	page: SpideredPage;
	expiresAt: number;
}

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
export class SpiderCache {
	private readonly map = new Map<string, CacheEntry>();
	private readonly maxSize: number;
	private readonly ttlMs: number;

	constructor(opts: SpiderCacheOptions = {}) {
		this.maxSize = opts.maxSize ?? 500;
		this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
	}

	/** Normalise a URL so http/https and trailing slashes don't cause misses. */
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
		const entry = this.map.get(k);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.map.delete(k);
			return undefined;
		}
		// Move to tail — most recently used
		this.map.delete(k);
		this.map.set(k, entry);
		return entry.page;
	}

	set(url: string, page: SpideredPage): void {
		const k = this.key(url);
		// Evict LRU (head of map) if at capacity
		if (this.map.size >= this.maxSize && !this.map.has(k)) {
			const lruKey = this.map.keys().next().value as string;
			this.map.delete(lruKey);
		}
		this.map.set(k, { page, expiresAt: Date.now() + this.ttlMs });
	}

	has(url: string): boolean {
		return this.get(url) !== undefined;
	}

	delete(url: string): void {
		this.map.delete(this.key(url));
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}

	/** All currently valid pages (does not update LRU order). */
	values(): SpideredPage[] {
		const now = Date.now();
		return [...this.map.values()].filter((e) => e.expiresAt > now).map((e) => e.page);
	}
}
