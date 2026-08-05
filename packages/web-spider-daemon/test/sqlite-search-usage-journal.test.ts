import { describe, expect, test } from "bun:test";
import { openWebSpiderDb } from "../src/db.ts";
import type { SearchEngineUsageEntry } from "../src/search/search-usage.ts";
import { SQLiteSearchUsageJournal } from "../src/search/sqlite-search-usage-journal.ts";

function entry(overrides: Partial<SearchEngineUsageEntry> = {}): SearchEngineUsageEntry {
	return { engine: "tavily", observedAt: 1_000, credits: 1, ...overrides };
}

describe("SQLiteSearchUsageJournal", () => {
	test("record() persists an entry; recent() returns it, newest first", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db);
		journal.record(entry({ observedAt: 1 }));
		journal.record(entry({ observedAt: 2 }));
		const recent = journal.recent();
		expect(recent.map((e) => e.observedAt)).toEqual([2, 1]);
		expect(recent[0]).toEqual(entry({ observedAt: 2 }));
	});

	test("recent() filters by engine", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db);
		journal.record(entry({ engine: "tavily", observedAt: 1 }));
		journal.record(entry({ engine: "exa", observedAt: 2 }));
		expect(journal.recent({ engine: "tavily" }).map((e) => e.engine)).toEqual(["tavily"]);
	});

	test("round-trips costUsd distinctly from credits, and omits whichever field wasn't set", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db);
		journal.record({ engine: "exa", observedAt: 1, costUsd: 0.006 });
		const [stored] = journal.recent();
		expect(stored).toEqual({ engine: "exa", observedAt: 1, costUsd: 0.006 });
		expect(stored).not.toHaveProperty("credits");
	});

	test("round-trips rateLimitHeaders as structured data, not a raw string", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db);
		journal.record({ engine: "brave", observedAt: 1, rateLimitHeaders: { "x-ratelimit-remaining": "5" } });
		const [stored] = journal.recent();
		expect(stored?.rateLimitHeaders).toEqual({ "x-ratelimit-remaining": "5" });
	});

	test("recent() bounds its own limit even if a caller asks for more than the configured cap", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db, { maxRows: 5 });
		for (let i = 0; i < 5; i++) journal.record(entry({ observedAt: i }));
		expect(journal.recent({ limit: 1_000_000 })).toHaveLength(5);
	});

	test("pruneOldest() keeps only the newest maxRows entries, oldest-first eviction", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db, { maxRows: 3 });
		for (let i = 0; i < 10; i++) journal.record(entry({ observedAt: i }));
		const remaining = journal.recent({ limit: 100 });
		expect(remaining).toHaveLength(3);
		expect(remaining.map((e) => e.observedAt)).toEqual([9, 8, 7]);
	});

	test("pruneOldest() is a no-op and returns 0 when under the cap", () => {
		const db = openWebSpiderDb(":memory:");
		const journal = new SQLiteSearchUsageJournal(db, { maxRows: 100 });
		journal.record(entry());
		expect(journal.pruneOldest()).toBe(0);
	});
});
