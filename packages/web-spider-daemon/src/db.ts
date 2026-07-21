/**
 * SQLite composition root — bun:sqlite, WAL, versioned migration via
 * PRAGMA user_version. Mirrors jittor/src/db.ts.
 *
 * Schema (design doc §2 — FTS5 candidate-prefiltering is explicitly
 * deferred; bounded `values()`/`search()` over the already-bounded
 * maxSize cache is sufficient at today's scale and matches the
 * pre-migration DiskCache's exact search behavior):
 *   pages  — one row per cached SpideredPage, normalized metadata columns
 *   chunks — RAG chunks, child of pages, cascade-deleted with their page
 *   images — scraped images, child of pages, inline base64 or file_path
 */
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from "./constants.ts";

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

function migrate(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version: number };
	if (row.user_version > SQLITE_SCHEMA_VERSION) {
		throw new Error(`database schema ${row.user_version} is newer than supported ${SQLITE_SCHEMA_VERSION}`);
	}
	if (row.user_version < 1) {
		const migration = db.transaction(() => {
			db.exec(INITIAL_SCHEMA);
			db.exec("PRAGMA user_version = 1");
		});
		migration.immediate();
	}
	const migrated = db.query("PRAGMA user_version").get() as { user_version: number };
	if (migrated.user_version !== SQLITE_SCHEMA_VERSION) {
		throw new Error(`missing migration from schema ${migrated.user_version} to ${SQLITE_SCHEMA_VERSION}`);
	}
}

export function openWebSpiderDb(path: string): Database {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	migrate(db);
	db.exec("PRAGMA optimize=0x10002");
	return db;
}

export function schemaVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}
