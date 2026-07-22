/**
 * SQLite composition root. Bootstrap (pragmas, PRAGMA user_version
 * migration runner) delegates to @danypops/daemon-kit's storage module --
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
import { openSqliteWithPragmas } from "@danypops/daemon-kit/storage";
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

export function openWebSpiderDb(path: string): Database {
	return openSqliteWithPragmas(path, {
		busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
		databaseOptions: { create: true, strict: true },
		migrations: [
			{ version: 1, up: (db) => db.exec(INITIAL_SCHEMA) },
			{ version: 2, up: (db) => db.exec(MIGRATION_2_SESSION_AUDIT_LOG) },
		],
	});
}

export function schemaVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}
