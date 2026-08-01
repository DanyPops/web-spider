import type { ICache, SpideredPage } from "@danypops/web-spider";
import type {
	CachedPageListFilter,
	CachedPageListResult,
	CachedPageSearchResult,
	CategoryAssignmentResult,
	CategoryListResult,
	CategoryRenameResult,
} from "../domain/page.ts";

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

	/** Creates the category if its name doesn't exist yet (case-insensitive). Idempotent -- assigning twice is a no-op. Throws if the url isn't cached. */
	assignCategory(url: string, category: string): CategoryAssignmentResult;
	/** Idempotent -- no error if the page/category association is already absent. */
	removeCategory(url: string, category: string): void;
	/** Renames in place, or merges into newName if it already exists as a different category (every association repoints to the surviving row). */
	renameCategory(category: string, newName: string): CategoryRenameResult;
	listCategories(): CategoryListResult;
	/** Category names assigned to a page, for Papyrus ingestion's relevance: labels. Empty for an uncached url or a page with none assigned. */
	categoriesForUrl(url: string): string[];

	close(): void;
}
