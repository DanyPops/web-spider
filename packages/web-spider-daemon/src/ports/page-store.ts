import type { CachedPageListFilter, CachedPageListResult, CachedPageSummary } from "../domain/page.ts";

/**
 * Storage boundary the application service depends on. SQLite is the only
 * adapter today (see adapters/sqlite-page-store.ts); domain/application code
 * must not import bun:sqlite directly.
 */
export interface PageStore {
	list(filter: CachedPageListFilter): CachedPageListResult;
	upsert(page: CachedPageSummary): void;
	pruneExpired(now: number): number;
	close(): void;
}
