/**
 * SQLite-backed, append-only SearchUsageJournal. See db.ts's
 * MIGRATION_4_SEARCH_ENGINE_USAGE for the schema.
 */
import type { Database } from "bun:sqlite";
import { SEARCH_ENGINE_USAGE_LOG_MAX_ROWS } from "../constants.ts";
import type { SearchEngineUsageEntry } from "./search-usage.ts";
import type { SearchUsageJournal } from "./search-usage-journal.ts";

interface UsageRow {
	engine: string;
	observed_at: number;
	credits: number | null;
	cost_usd: number | null;
	rate_limit_headers: string | null;
}

function rowToEntry(row: UsageRow): SearchEngineUsageEntry {
	return {
		engine: row.engine,
		observedAt: row.observed_at,
		...(row.credits !== null ? { credits: row.credits } : {}),
		...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
		...(row.rate_limit_headers !== null ? { rateLimitHeaders: JSON.parse(row.rate_limit_headers) as Record<string, string> } : {}),
	};
}

export class SQLiteSearchUsageJournal implements SearchUsageJournal {
	private readonly maxRows: number;

	constructor(
		private readonly db: Database,
		opts: { maxRows?: number } = {},
	) {
		this.maxRows = opts.maxRows ?? SEARCH_ENGINE_USAGE_LOG_MAX_ROWS;
	}

	record(entry: SearchEngineUsageEntry): void {
		this.db
			.query("INSERT INTO search_engine_usage (engine, observed_at, credits, cost_usd, rate_limit_headers) VALUES (?, ?, ?, ?, ?)")
			.run(
				entry.engine,
				entry.observedAt,
				entry.credits ?? null,
				entry.costUsd ?? null,
				entry.rateLimitHeaders ? JSON.stringify(entry.rateLimitHeaders) : null,
			);
		this.pruneOldest();
	}

	recent(opts: { engine?: string; limit?: number } = {}): SearchEngineUsageEntry[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 100, this.maxRows));
		const rows = opts.engine
			? (this.db
					.query(
						"SELECT engine, observed_at, credits, cost_usd, rate_limit_headers FROM search_engine_usage WHERE engine = ? ORDER BY id DESC LIMIT ?",
					)
					.all(opts.engine, limit) as UsageRow[])
			: (this.db
					.query("SELECT engine, observed_at, credits, cost_usd, rate_limit_headers FROM search_engine_usage ORDER BY id DESC LIMIT ?")
					.all(limit) as UsageRow[]);
		return rows.map(rowToEntry);
	}

	pruneOldest(): number {
		// Pre-count and pass the exact row count to DELETE explicitly rather than
		// trusting bun:sqlite's post-hoc .changes (see sqlite-cache-store.ts's
		// pruneExpired for the original real bug this pattern avoids repeating).
		const { count } = this.db.query("SELECT COUNT(*) as count FROM search_engine_usage").get() as { count: number };
		const excess = count - this.maxRows;
		if (excess <= 0) return 0;
		this.db.query("DELETE FROM search_engine_usage WHERE id IN (SELECT id FROM search_engine_usage ORDER BY id ASC LIMIT ?)").run(excess);
		return excess;
	}
}
