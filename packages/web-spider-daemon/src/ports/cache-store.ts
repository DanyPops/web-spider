import type { ICache, SpideredPage } from "@danypops/web-spider";
import type { CachedPageListFilter, CachedPageListResult, CachedPageSearchResult } from "../domain/page.ts";

/**
 * Storage boundary the application/service layer depends on. This is the
 * existing @danypops/web-spider `ICache<string, SpideredPage>` port — the
 * daemon's SQLite adapter is a drop-in replacement for the library's
 * DiskCache/SpiderCache adapters, per the design doc — extended with the
 * two bounded query shapes the daemon exposes as operations (`cache.list`,
 * `cache.search`) and daemon-only maintenance.
 */
export interface CacheStore extends ICache<string, SpideredPage> {
	list(filter: CachedPageListFilter): CachedPageListResult;
	search(query: string, opts?: { topN?: number; snippetRadius?: number }): CachedPageSearchResult;
	/** Deletes expired rows outright (SQL, not a JS scan). Returns rows removed. */
	pruneExpired(now: number): number;
	close(): void;
}
