import type { Database } from "bun:sqlite";
import { CACHE_LIST_DEFAULT_LIMIT, CACHE_LIST_MAX_LIMIT } from "../constants.ts";
import type { CachedPageListFilter, CachedPageListResult, CachedPageSummary } from "../domain/page.ts";
import type { PageStore } from "../ports/page-store.ts";

interface PageRow {
	url: string;
	domain: string;
	title: string;
	description: string;
	fetched_at: number;
	expires_at: number;
}

function fromRow(row: PageRow): CachedPageSummary {
	return {
		url: row.url,
		domain: row.domain,
		title: row.title,
		description: row.description,
		fetchedAt: row.fetched_at,
		expiresAt: row.expires_at,
	};
}

/** Normalizes a URL to a stable cache key — strips the hash and trailing slash. */
export function pageKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

export class SQLitePageStore implements PageStore {
	constructor(private readonly db: Database) {}

	list(filter: CachedPageListFilter = {}): CachedPageListResult {
		const now = Date.now();
		const total = (this.db.query("SELECT COUNT(*) AS n FROM pages WHERE expires_at > ?").get(now) as { n: number }).n;

		const conditions = ["expires_at > ?"];
		const parameters: Array<string | number> = [now];
		if (filter.grep?.trim()) {
			const pattern = `%${filter.grep.trim().toLowerCase()}%`;
			conditions.push("(LOWER(url) LIKE ? OR LOWER(title) LIKE ? OR LOWER(domain) LIKE ? OR LOWER(description) LIKE ?)");
			parameters.push(pattern, pattern, pattern, pattern);
		}
		const where = `WHERE ${conditions.join(" AND ")}`;
		const filtered = (this.db.query(`SELECT COUNT(*) AS n FROM pages ${where}`).get(...parameters) as { n: number }).n;

		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		const limit = Math.max(1, Math.min(CACHE_LIST_MAX_LIMIT, Math.floor(filter.limit ?? CACHE_LIST_DEFAULT_LIMIT)));
		const rows = this.db.query(`
			SELECT url, domain, title, description, fetched_at, expires_at
			FROM pages
			${where}
			ORDER BY fetched_at DESC
			LIMIT ? OFFSET ?
		`).all(...parameters, limit, offset) as PageRow[];

		return { total, filtered, offset, limit, pages: rows.map(fromRow) };
	}

	upsert(page: CachedPageSummary): void {
		const key = pageKey(page.url);
		this.db.query(`
			INSERT INTO pages (url_key, url, domain, title, description, fetched_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(url_key) DO UPDATE SET
				url = excluded.url, domain = excluded.domain, title = excluded.title,
				description = excluded.description, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
		`).run(key, page.url, page.domain, page.title, page.description, page.fetchedAt, page.expiresAt);
	}

	pruneExpired(now: number): number {
		return this.db.query("DELETE FROM pages WHERE expires_at <= ?").run(now).changes;
	}

	close(): void {
		this.db.close();
	}
}
