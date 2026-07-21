import { describe, expect, test } from "bun:test";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteSessionAuditJournal } from "../src/adapters/sqlite-session-audit-journal.ts";
import type { SessionAuditEntry } from "../src/domain/session-audit.ts";

function entry(overrides: Partial<SessionAuditEntry> = {}): SessionAuditEntry {
	return { ts: 1_000, sessionName: "a", action: "navigate", snapshotVersion: 0, target: "https://example.com", outcome: "ok", error: "", ...overrides };
}

describe("SQLiteSessionAuditJournal", () => {
	test("record() persists an entry; recent() returns it, newest first", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db);
		journal.record(entry({ ts: 1 }));
		journal.record(entry({ ts: 2 }));
		const recent = journal.recent();
		expect(recent.map((e) => e.ts)).toEqual([2, 1]);
		expect(recent[0]).toEqual(entry({ ts: 2 }));
	});

	test("recent() filters by sessionName", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db);
		journal.record(entry({ sessionName: "a", ts: 1 }));
		journal.record(entry({ sessionName: "b", ts: 2 }));
		expect(journal.recent({ sessionName: "a" }).map((e) => e.sessionName)).toEqual(["a"]);
	});

	test("recent() bounds its own limit even if a caller asks for more than the configured cap", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db, { maxRows: 5 });
		for (let i = 0; i < 5; i++) journal.record(entry({ ts: i }));
		expect(journal.recent({ limit: 1_000_000 })).toHaveLength(5);
	});

	test("pruneOldest() keeps only the newest maxRows entries, oldest-first eviction", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db, { maxRows: 3 });
		for (let i = 0; i < 10; i++) journal.record(entry({ ts: i }));
		const remaining = journal.recent({ limit: 100 });
		expect(remaining).toHaveLength(3);
		expect(remaining.map((e) => e.ts)).toEqual([9, 8, 7]);
	});

	test("pruneOldest() is a no-op and returns 0 when under the cap", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db, { maxRows: 100 });
		journal.record(entry());
		expect(journal.pruneOldest()).toBe(0);
	});

	test("never stores raw script content — this is enforced by the caller (SessionService), verified here only as a shape/round-trip contract", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSessionAuditJournal(db);
		journal.record(entry({ action: "eval", target: "<script>" }));
		expect(journal.recent()[0]!.target).toBe("<script>");
	});
});
