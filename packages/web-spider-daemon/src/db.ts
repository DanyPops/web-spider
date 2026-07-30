/**
 * SQLite composition root. Bootstrap (pragmas, PRAGMA user_version
 * migration runner) delegates to @danypops/vehicle-server's storage module --
 * this file used to duplicate that skeleton with jittor's/papyrus's own
 * copies byte-for-byte. Web Spider's actual schema stays entirely here.
 *
 * Schema (design doc §2 — FTS5 candidate-prefiltering is explicitly
 * deferred; bounded `values()`/`search()` over the already-bounded
 * maxSize cache is sufficient at today's scale and matches the
 * pre-migration DiskCache's exact search behavior):
 *   pages  — one row per cached SpideredPage, normalized metadata columns
 *   chunks — RAG chunks, child of pages, cascade-deleted with their page
 *   images — scraped images, child of pages, inline base64 or file_path
 */
import type { Database } from "bun:sqlite";
import { openSqliteWithPragmas } from "@danypops/vehicle-server/storage";
import { SQLITE_BUSY_TIMEOUT_MS } from "./constants.ts";

const INITIAL_SCHEMA = `
CREATE TABLE pages (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	url_key       TEXT NOT NULL UNIQUE,
	url           TEXT NOT NULL,
	canonical_url TEXT,
	domain        TEXT NOT NULL,
	title         TEXT NOT NULL DEFAULT '',
	description   TEXT NOT NULL DEFAULT '',
	author        TEXT NOT NULL DEFAULT '',
	published_at  TEXT NOT NULL DEFAULT '',
	lang          TEXT NOT NULL DEFAULT '',
	tags          TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
	word_count    INTEGER NOT NULL DEFAULT 0,
	reading_time_minutes INTEGER NOT NULL DEFAULT 0,
	headings      TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(headings)),
	links         TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
	markdown      TEXT NOT NULL DEFAULT '',
	js_rendered   INTEGER NOT NULL DEFAULT 0,
	fetched_at    INTEGER NOT NULL CHECK(fetched_at >= 0),
	expires_at    INTEGER NOT NULL CHECK(expires_at >= 0)
);
CREATE INDEX pages_domain_idx     ON pages(domain);
CREATE INDEX pages_expires_at_idx ON pages(expires_at);
CREATE INDEX pages_fetched_at_idx ON pages(fetched_at);

CREATE TABLE chunks (
	id           TEXT PRIMARY KEY,
	page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
	idx          INTEGER NOT NULL,
	heading      TEXT NOT NULL DEFAULT '',
	text         TEXT NOT NULL,
	word_count   INTEGER NOT NULL,
	content_type TEXT NOT NULL
);
CREATE INDEX chunks_page_idx ON chunks(page_id);

CREATE TABLE images (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
	src        TEXT NOT NULL,
	mime_type  TEXT NOT NULL,
	alt        TEXT NOT NULL DEFAULT '',
	base64     TEXT,
	file_path  TEXT,
	CHECK ((base64 IS NOT NULL) OR (file_path IS NOT NULL))
);
CREATE INDEX images_page_idx ON images(page_id);
`;

// Append-only audit journal for session.act calls (Seeshell-derived "content-free
// promoted evidence" principle) -- application code only ever INSERTs here, never
// UPDATEs or DELETEs a row's own content (pruneOldest() only removes whole old
// rows once the bound is exceeded, it never edits a kept row).
const MIGRATION_2_SESSION_AUDIT_LOG = `
CREATE TABLE session_audit_log (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	ts               INTEGER NOT NULL,
	session_name     TEXT NOT NULL,
	action           TEXT NOT NULL,
	snapshot_version INTEGER NOT NULL,
	target           TEXT NOT NULL DEFAULT '',
	outcome          TEXT NOT NULL,
	error            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX session_audit_log_session_idx ON session_audit_log(session_name);
CREATE INDEX session_audit_log_ts_idx ON session_audit_log(ts);
`;

// Categories are agent/user-curated judgments about what a page is *for* --
// distinct from `tags` (publisher-provided, auto-extracted from HTML) and
// `domain` (mechanical). A real id (not free text per page) so renaming or
// merging a category is one UPDATE, not a rewrite of every page that used
// the old name. Many-to-many: a page belongs to as many categories as apply.
const MIGRATION_3_CATEGORIES = `
CREATE TABLE categories (
	id   INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE page_categories (
	page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
	category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
	PRIMARY KEY (page_id, category_id)
);
CREATE INDEX page_categories_category_idx ON page_categories(category_id);
`;

// Records what one search-engine call itself reported about its own usage/cost
// (Tavily credits, Exa costDollars, Brave rate-limit-shaped headers when
// present) -- never a running account balance, no provider exposes one; a
// consumer accumulates these rows itself for that. Append-only, same shape as
// session_audit_log: application code only INSERTs, pruneOldest() only removes
// whole old rows once the bound is exceeded.
const MIGRATION_4_SEARCH_ENGINE_USAGE = `
CREATE TABLE search_engine_usage (
	id                 INTEGER PRIMARY KEY AUTOINCREMENT,
	engine             TEXT NOT NULL,
	observed_at        INTEGER NOT NULL CHECK(observed_at >= 0),
	credits            REAL,
	cost_usd           REAL,
	rate_limit_headers TEXT CHECK(rate_limit_headers IS NULL OR json_valid(rate_limit_headers))
);
CREATE INDEX search_engine_usage_engine_idx ON search_engine_usage(engine);
CREATE INDEX search_engine_usage_observed_at_idx ON search_engine_usage(observed_at);
`;

export function openWebSpiderDb(path: string): Database {
	return openSqliteWithPragmas(path, {
		busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
		databaseOptions: { create: true, strict: true },
		migrations: [
			{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) },
			{ version: 2, up: (db) => db.exec(MIGRATION_2_SESSION_AUDIT_LOG) },
			{ version: 3, up: (db) => db.exec(MIGRATION_3_CATEGORIES) },
			{ version: 4, up: (db) => db.exec(MIGRATION_4_SEARCH_ENGINE_USAGE) },
		],
	});
}

export function schemaVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}
