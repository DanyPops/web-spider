import { describe, expect, test } from "bun:test";
import { openWebSpiderDb } from "../src/db.ts";
import { pageKey, SQLitePageStore } from "../src/adapters/sqlite-page-store.ts";

function seeded() {
	const db = openWebSpiderDb(":memory:");
	const store = new SQLitePageStore(db);
	return { db, store };
}

describe("pageKey", () => {
	test("strips the hash and trailing slash", () => {
		expect(pageKey("https://example.com/a/#section")).toBe("https://example.com/a");
	});

	test("falls back to the raw string for unparseable input", () => {
		expect(pageKey("not a url")).toBe("not a url");
	});
});

describe("SQLitePageStore", () => {
	test("list() on an empty store returns a bounded empty result", () => {
		const { store } = seeded();
		const result = store.list({});
		expect(result).toEqual({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] });
	});

	test("upsert() then list() round-trips a page, newest first", () => {
		const { store } = seeded();
		const now = Date.now();
		store.upsert({ url: "https://a.example/1", domain: "a.example", title: "One", description: "", fetchedAt: now - 1_000, expiresAt: now + 60_000 });
		store.upsert({ url: "https://a.example/2", domain: "a.example", title: "Two", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		const result = store.list({});
		expect(result.total).toBe(2);
		expect(result.pages.map((p) => p.url)).toEqual(["https://a.example/2", "https://a.example/1"]);
	});

	test("upsert() on the same URL updates in place rather than duplicating", () => {
		const { store } = seeded();
		const now = Date.now();
		store.upsert({ url: "https://a.example/1", domain: "a.example", title: "Old title", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		store.upsert({ url: "https://a.example/1", domain: "a.example", title: "New title", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		const result = store.list({});
		expect(result.total).toBe(1);
		expect(result.pages[0]?.title).toBe("New title");
	});

	test("list() excludes expired entries", () => {
		const { store } = seeded();
		const now = Date.now();
		store.upsert({ url: "https://a.example/expired", domain: "a.example", title: "Expired", description: "", fetchedAt: now - 120_000, expiresAt: now - 60_000 });
		const result = store.list({});
		expect(result.total).toBe(0);
	});

	test("grep filters case-insensitively across url/title/domain/description", () => {
		const { store } = seeded();
		const now = Date.now();
		store.upsert({ url: "https://a.example/match", domain: "a.example", title: "Findable Title", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		store.upsert({ url: "https://b.example/other", domain: "b.example", title: "Nothing here", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		const result = store.list({ grep: "FINDABLE" });
		expect(result.filtered).toBe(1);
		expect(result.pages[0]?.url).toBe("https://a.example/match");
	});

	test("limit is bounded to the hard cap even when a larger limit is requested", () => {
		const { store } = seeded();
		const now = Date.now();
		for (let i = 0; i < 5; i += 1) {
			store.upsert({ url: `https://a.example/${i}`, domain: "a.example", title: `Page ${i}`, description: "", fetchedAt: now + i, expiresAt: now + 60_000 });
		}
		const result = store.list({ limit: 100_000 });
		expect(result.limit).toBe(100); // CACHE_LIST_MAX_LIMIT
		expect(result.pages.length).toBe(5);
	});

	test("pruneExpired() deletes only expired rows and reports the count", () => {
		const { store } = seeded();
		const now = Date.now();
		store.upsert({ url: "https://a.example/keep", domain: "a.example", title: "Keep", description: "", fetchedAt: now, expiresAt: now + 60_000 });
		store.upsert({ url: "https://a.example/gone", domain: "a.example", title: "Gone", description: "", fetchedAt: now, expiresAt: now - 1_000 });
		const deleted = store.pruneExpired(now);
		expect(deleted).toBe(1);
		expect(store.list({}).total).toBe(1);
	});
});
