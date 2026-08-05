import type { SearchEngineUsageEntry } from "./search-usage.ts";

/**
 * Append-only usage journal -- record() is the only write path application
 * code ever calls; there is deliberately no update/delete-a-row method.
 * pruneOldest() removes whole old rows once the bound is exceeded, it never
 * edits kept rows' content.
 */
export interface SearchUsageJournal {
	record(entry: SearchEngineUsageEntry): void;
	/** Bounded read, newest first. */
	recent(opts?: { engine?: string; limit?: number }): SearchEngineUsageEntry[];
	/** Deletes oldest rows beyond the configured cap. Returns rows removed. */
	pruneOldest(): number;
}
