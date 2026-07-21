/**
 * SQLite composition root — bun:sqlite, WAL, versioned migration via
 * PRAGMA user_version. Mirrors jittor/src/db.ts.
 *
 * The walking skeleton ships a minimal `pages` table just wide enough for
 * the `cache.list` operation (url/domain/title lookup, TTL/eviction
 * columns). The cache-migration task extends this schema (chunks, images,
 * FTS5) via a schema-version bump — it must not redefine columns already
 * shipped here.
 */
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from "./constants.ts";

const INITIAL_SCHEMA = `
CREATE TABLE pages (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	url_key     TEXT NOT NULL UNIQUE,
	url         TEXT NOT NULL,
	domain      TEXT NOT NULL,
	title       TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	fetched_at  INTEGER NOT NULL CHECK(fetched_at >= 0),
	expires_at  INTEGER NOT NULL CHECK(expires_at >= 0)
);
CREATE INDEX pages_domain_idx     ON pages(domain);
CREATE INDEX pages_expires_at_idx ON pages(expires_at);
CREATE INDEX pages_fetched_at_idx ON pages(fetched_at);
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
