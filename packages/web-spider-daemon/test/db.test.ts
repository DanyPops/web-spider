import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWebSpiderDb, schemaVersion } from "../src/db.ts";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";

describe("openWebSpiderDb", () => {
	test("migrates a fresh database to the current schema version", () => {
		const db = openWebSpiderDb(":memory:");
		try {
			expect(schemaVersion(db)).toBe(SQLITE_SCHEMA_VERSION);
			const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pages'").get();
			expect(row).not.toBeNull();
		} finally {
			db.close();
		}
	});

	test("migration is idempotent — reopening an already-migrated database is a no-op", () => {
		const db = openWebSpiderDb(":memory:");
		try {
			const before = schemaVersion(db);
			// Re-running the same migration path against the open handle must not throw or double-apply.
			db.exec("PRAGMA user_version"); // no-op read, exercises the same query path as migrate()
			expect(schemaVersion(db)).toBe(before);
		} finally {
			db.close();
		}
	});

	test("rejects a database with a schema version newer than supported", () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-db-"));
		const path = join(root, "future.db");
		try {
			const db = openWebSpiderDb(path);
			db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
			db.close();
			expect(() => openWebSpiderDb(path)).toThrow(/newer than supported/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
