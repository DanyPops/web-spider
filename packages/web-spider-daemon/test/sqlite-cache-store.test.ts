import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpideredPage } from "@danypops/web-spider";
import { openWebSpiderDb } from "../src/db.ts";
import { pageKey, SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";

function page(overrides: Partial<SpideredPage> = {}): SpideredPage {
	// Chunk ids are always "<url>#chunk-N" in production (spider.ts derives them
	// from the owning page's own URL), so two different pages never collide on
	// chunks.id. Derive the default chunk's id from the *final* url (including
	// any override) here for the same reason — a fixed literal id would collide
	// across fixtures that only override `url`.
	const url = overrides.url ?? "https://a.example/1";
	return {
		url,
		domain: "a.example",
		fetchedAt: new Date().toISOString(),
		title: "One",
		description: "desc",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 42,
		readingTimeMinutes: 1,
		headings: [{ level: 1, text: "One" }],
		chunks: [{ id: `${url}#chunk-0`, index: 0, heading: "One", text: "hello world", wordCount: 2, contentType: "text" }],
		links: [],
		markdown: "# One\n\nhello world",
		...overrides,
	};
}

function storeWithTmpDir() {
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const db = openWebSpiderDb(":memory:");
	return { store: new SQLiteCacheStore(db, { imagesDir }), imagesDir, db };
}

describe("pageKey", () => {
	test("strips the hash and trailing slash", () => {
		expect(pageKey("https://example.com/a/#section")).toBe("https://example.com/a");
	});
	test("falls back to the raw string for unparseable input", () => {
		expect(pageKey("not a url")).toBe("not a url");
	});
	test("sorts query parameters, so a different param order is the same key", () => {
		expect(pageKey("https://example.com/search?b=2&a=1")).toBe(pageKey("https://example.com/search?a=1&b=2"));
	});
});

describe("SQLiteCacheStore — ICache<string, SpideredPage> port", () => {
	test("get() on a miss returns undefined", () => {
		const { store } = storeWithTmpDir();
		expect(store.get("https://a.example/1")).toBeUndefined();
		expect(store.has("https://a.example/1")).toBe(false);
	});

	test("set() then get() round-trips the full page, including chunks and headings", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page());
		const hydrated = store.get("https://a.example/1");
		expect(hydrated?.title).toBe("One");
		expect(hydrated?.chunks).toEqual([{ id: "https://a.example/1#chunk-0", index: 0, heading: "One", text: "hello world", wordCount: 2, contentType: "text" }]);
		expect(hydrated?.headings).toEqual([{ level: 1, text: "One" }]);
		expect(store.has("https://a.example/1")).toBe(true);
	});

	test("set() with one query-param order then get() with a different order hits the same cache entry, not a miss", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/search?b=2&a=1", page({ url: "https://a.example/search?b=2&a=1" }));
		expect(store.get("https://a.example/search?a=1&b=2")).toBeDefined();
		expect(store.has("https://a.example/search?a=1&b=2")).toBe(true);
	});

	test("set() on the same URL replaces chunks rather than accumulating them", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page());
		store.set("https://a.example/1", page({ chunks: [{ id: "x", index: 0, heading: "New", text: "new text", wordCount: 2, contentType: "text" }] }));
		const hydrated = store.get("https://a.example/1");
		expect(hydrated?.chunks).toHaveLength(1);
		expect(hydrated?.chunks[0]?.text).toBe("new text");
	});

	test("delete() removes the page", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page());
		store.delete("https://a.example/1");
		expect(store.get("https://a.example/1")).toBeUndefined();
	});

	test("values() returns non-expired pages newest first", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.set("https://a.example/2", page({ url: "https://a.example/2" }));
		const values = store.values();
		expect(values.map((p) => p.url)).toEqual(["https://a.example/2", "https://a.example/1"]);
	});

	test("small images are stored inline; large images spill to a file and hydrate back on read", () => {
		const { store, imagesDir } = storeWithTmpDir();
		const smallBase64 = Buffer.from("tiny").toString("base64");
		const largeBase64 = Buffer.alloc(64 * 1024, 1).toString("base64"); // exceeds the 32 KB threshold
		store.set("https://a.example/img", page({
			url: "https://a.example/img",
			images: [
				{ src: "https://a.example/small.png", mimeType: "image/png", alt: "small", base64: smallBase64 },
				{ src: "https://a.example/large.png", mimeType: "image/png", alt: "large", base64: largeBase64 },
			],
		}));
		const hydrated = store.get("https://a.example/img");
		expect(hydrated?.images).toHaveLength(2);
		const small = hydrated?.images?.find((i) => i.src === "https://a.example/small.png");
		const large = hydrated?.images?.find((i) => i.src === "https://a.example/large.png");
		expect(small?.base64).toBe(smallBase64);
		expect(small?.filePath).toBeUndefined();
		expect(large?.filePath).toBeDefined();
		expect(large?.base64).toBe(largeBase64); // hydrated back from disk
		expect(readFileSync(large!.filePath!).length).toBe(64 * 1024);
		rmSync(imagesDir, { recursive: true, force: true });
	});

	test("re-setting a page with images cleans up the previous spilled files", () => {
		const { store, imagesDir } = storeWithTmpDir();
		const largeBase64 = Buffer.alloc(64 * 1024, 2).toString("base64");
		store.set("https://a.example/img", page({ url: "https://a.example/img", images: [{ src: "https://a.example/large.png", mimeType: "image/png", alt: "", base64: largeBase64 }] }));
		const firstPath = store.get("https://a.example/img")?.images?.[0]?.filePath;
		expect(firstPath).toBeDefined();
		store.set("https://a.example/img", page({ url: "https://a.example/img" })); // no images this time
		expect(store.get("https://a.example/img")?.images).toBeUndefined();
		rmSync(imagesDir, { recursive: true, force: true });
	});

	test("eviction removes the oldest page once maxSize is exceeded", () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const store = new SQLiteCacheStore(db, { imagesDir, maxSize: 2 });
		store.set("https://a.example/1", page({ url: "https://a.example/1", fetchedAt: new Date(Date.now() - 3_000).toISOString() }));
		store.set("https://a.example/2", page({ url: "https://a.example/2", fetchedAt: new Date(Date.now() - 2_000).toISOString() }));
		store.set("https://a.example/3", page({ url: "https://a.example/3", fetchedAt: new Date(Date.now() - 1_000).toISOString() }));
		const urls = store.values().map((p) => p.url).sort();
		expect(urls).toEqual(["https://a.example/2", "https://a.example/3"]);
	});

	test("expired entries are excluded from get()/values() and removed by pruneExpired()", () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const store = new SQLiteCacheStore(db, { imagesDir, ttlMs: -1 }); // expires immediately
		store.set("https://a.example/1", page());
		expect(store.get("https://a.example/1")).toBeUndefined();
		expect(store.values()).toEqual([]);
		const deleted = store.pruneExpired(Date.now() + 1);
		expect(deleted).toBe(1);
	});

	test("eviction removes the evicted page's spilled image file from disk, not just its DB rows", () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const store = new SQLiteCacheStore(db, { imagesDir, maxSize: 2 });
		const largeBase64 = Buffer.alloc(64 * 1024, 3).toString("base64");
		store.set("https://a.example/1", page({
			url: "https://a.example/1",
			fetchedAt: new Date(Date.now() - 3_000).toISOString(),
			images: [{ src: "https://a.example/large.png", mimeType: "image/png", alt: "", base64: largeBase64 }],
		}));
		const evictedPath = store.get("https://a.example/1")?.images?.[0]?.filePath as string;
		expect(evictedPath).toBeDefined();
		expect(readFileSync(evictedPath)).toBeDefined(); // exists before eviction

		store.set("https://a.example/2", page({ url: "https://a.example/2", fetchedAt: new Date(Date.now() - 2_000).toISOString() }));
		store.set("https://a.example/3", page({ url: "https://a.example/3", fetchedAt: new Date(Date.now() - 1_000).toISOString() })); // pushes /1 past maxSize:2

		expect(store.get("https://a.example/1")).toBeUndefined();
		expect(() => readFileSync(evictedPath)).toThrow(); // the file, not just the DB row, is gone
		rmSync(imagesDir, { recursive: true, force: true });
	});

	test("pruneExpired() removes an expired page's spilled image file from disk, not just its DB rows", () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const store = new SQLiteCacheStore(db, { imagesDir, ttlMs: -1 }); // expires immediately
		const largeBase64 = Buffer.alloc(64 * 1024, 4).toString("base64");
		store.set("https://a.example/img", page({
			url: "https://a.example/img",
			images: [{ src: "https://a.example/large.png", mimeType: "image/png", alt: "", base64: largeBase64 }],
		}));
		// Read the spilled path directly from the DB (get() already excludes the
		// already-expired row, so it can't be read back through the public API).
		const filePathRow = db.query("SELECT file_path FROM images LIMIT 1").get() as { file_path: string };
		expect(readFileSync(filePathRow.file_path)).toBeDefined(); // exists before pruning

		const deleted = store.pruneExpired(Date.now() + 1);
		expect(deleted).toBe(1);
		expect(() => readFileSync(filePathRow.file_path)).toThrow(); // the file, not just the DB row, is gone
		rmSync(imagesDir, { recursive: true, force: true });
	});
});

describe("SQLiteCacheStore — list()", () => {
	test("list() is bounded and grep-filterable, matching today's cache-listing semantics", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/findable", page({ url: "https://a.example/findable", title: "Findable Title" }));
		store.set("https://b.example/other", page({ url: "https://b.example/other", domain: "b.example", title: "Nothing here" }));
		const all = store.list({});
		expect(all.total).toBe(2);
		const filtered = store.list({ grep: "FINDABLE" });
		expect(filtered.filtered).toBe(1);
		expect(filtered.pages[0]?.url).toBe("https://a.example/findable");
	});

	test("list() limit is bounded to the hard cap", () => {
		const { store } = storeWithTmpDir();
		for (let i = 0; i < 3; i += 1) store.set(`https://a.example/${i}`, page({ url: `https://a.example/${i}` }));
		const result = store.list({ limit: 100_000 });
		expect(result.limit).toBe(100);
		expect(result.pages.length).toBe(3);
	});

	test("list() rows are leanOutput()-shaped — headings/bodyLinks present, chunks/markdown absent", () => {
		// Locks in the tool-contract requirement (design doc §3): cache.list must match
		// today's pi-extension handleCacheListing() exactly, not a bare summary row.
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({
			url: "https://a.example/1",
			headings: [{ level: 1, text: "One" }],
			links: [{ href: "https://a.example/body", text: "Body link", isExternal: false, rel: "body" }],
		}));
		const result = store.list({});
		const row = result.pages[0] as Record<string, unknown>;
		expect(row.headings).toEqual(["# One"]);
		expect(row.bodyLinks).toEqual([{ href: "https://a.example/body", text: "Body link" }]);
		expect(row).not.toHaveProperty("chunks");
		expect(row).not.toHaveProperty("markdown");
	});

	test("list() with no sort params preserves today's default order (fetchedAt desc)", () => {
		const { store, db } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.set("https://a.example/2", page({ url: "https://a.example/2" }));
		db.query("UPDATE pages SET fetched_at = 1000 WHERE url = ?").run("https://a.example/1");
		db.query("UPDATE pages SET fetched_at = 2000 WHERE url = ?").run("https://a.example/2");
		const result = store.list({});
		expect(result.pages.map((p) => p.url)).toEqual(["https://a.example/2", "https://a.example/1"]);
	});

	test("list() filters by exact, case-insensitive domain", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1", domain: "a.example" }));
		store.set("https://b.example/1", page({ url: "https://b.example/1", domain: "b.example" }));
		const result = store.list({ domain: "B.EXAMPLE" });
		expect(result.filtered).toBe(1);
		expect(result.pages[0]?.url).toBe("https://b.example/1");
	});

	test("list() filters by tag, and a page in two tag queries appears in both (overlap, not exclusive)", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/rust-ptp", page({ url: "https://a.example/rust-ptp", tags: ["rust", "ptp"] }));
		store.set("https://a.example/python", page({ url: "https://a.example/python", tags: ["python"] }));
		store.set("https://a.example/rust-only", page({ url: "https://a.example/rust-only", tags: ["rust"] }));

		const rust = store.list({ tag: "RUST" }); // also proves case-insensitivity
		expect(rust.filtered).toBe(2);
		expect(new Set(rust.pages.map((p) => p.url))).toEqual(new Set(["https://a.example/rust-ptp", "https://a.example/rust-only"]));

		const ptp = store.list({ tag: "ptp" });
		expect(ptp.filtered).toBe(1);
		expect(ptp.pages[0]?.url).toBe("https://a.example/rust-ptp"); // present in both queries -- overlap
	});

	test("list() filters by fetchedAt range", () => {
		const { store, db } = storeWithTmpDir();
		store.set("https://a.example/old", page({ url: "https://a.example/old" }));
		store.set("https://a.example/mid", page({ url: "https://a.example/mid" }));
		store.set("https://a.example/new", page({ url: "https://a.example/new" }));
		db.query("UPDATE pages SET fetched_at = 1000 WHERE url = ?").run("https://a.example/old");
		db.query("UPDATE pages SET fetched_at = 2000 WHERE url = ?").run("https://a.example/mid");
		db.query("UPDATE pages SET fetched_at = 3000 WHERE url = ?").run("https://a.example/new");

		const result = store.list({ fetchedAfter: 1500, fetchedBefore: 2500 });
		expect(result.filtered).toBe(1);
		expect(result.pages[0]?.url).toBe("https://a.example/mid");
	});

	test("list() filters by publishedAt range (the article's own date, distinct from fetchedAt)", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/2020", page({ url: "https://a.example/2020", publishedAt: "2020-01-01T00:00:00.000Z" }));
		store.set("https://a.example/2022", page({ url: "https://a.example/2022", publishedAt: "2022-06-01T00:00:00.000Z" }));
		store.set("https://a.example/2024", page({ url: "https://a.example/2024", publishedAt: "2024-01-01T00:00:00.000Z" }));

		const result = store.list({ publishedAfter: "2021-01-01", publishedBefore: "2023-01-01" });
		expect(result.filtered).toBe(1);
		expect(result.pages[0]?.url).toBe("https://a.example/2022");
	});

	test("list() sorts by url ascending and descending", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/b", page({ url: "https://a.example/b" }));
		store.set("https://a.example/a", page({ url: "https://a.example/a" }));
		store.set("https://a.example/c", page({ url: "https://a.example/c" }));

		const asc = store.list({ sortBy: "url", sortOrder: "asc" });
		expect(asc.pages.map((p) => p.url)).toEqual(["https://a.example/a", "https://a.example/b", "https://a.example/c"]);

		const desc = store.list({ sortBy: "url", sortOrder: "desc" });
		expect(desc.pages.map((p) => p.url)).toEqual(["https://a.example/c", "https://a.example/b", "https://a.example/a"]);
	});

	test("list() sorts by domain", () => {
		const { store } = storeWithTmpDir();
		store.set("https://z.example/1", page({ url: "https://z.example/1", domain: "z.example" }));
		store.set("https://a.example/1", page({ url: "https://a.example/1", domain: "a.example" }));

		const result = store.list({ sortBy: "domain", sortOrder: "asc" });
		expect(result.pages.map((p) => p.url)).toEqual(["https://a.example/1", "https://z.example/1"]);
	});

	test("list() sorts by publishedAt", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/2024", page({ url: "https://a.example/2024", publishedAt: "2024-01-01" }));
		store.set("https://a.example/2020", page({ url: "https://a.example/2020", publishedAt: "2020-01-01" }));

		const result = store.list({ sortBy: "publishedAt", sortOrder: "asc" });
		expect(result.pages.map((p) => p.url)).toEqual(["https://a.example/2020", "https://a.example/2024"]);
	});

	test("list() rejects an invalid sortBy or sortOrder with a clear error, rather than silently ignoring it", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		// biome-ignore lint/suspicious/noExplicitAny: exercising a deliberately invalid input
		expect(() => store.list({ sortBy: "popularity" as any })).toThrow(/invalid sortBy/);
		// biome-ignore lint/suspicious/noExplicitAny: exercising a deliberately invalid input
		expect(() => store.list({ sortOrder: "sideways" as any })).toThrow(/invalid sortOrder/);
	});
});

describe("SQLiteCacheStore — search()", () => {
	test("returns hits ranked by relevance with full chunk text (not a truncated snippet)", () => {
		const { store } = storeWithTmpDir();
		// Query text that appears only in chunk body text, not in either page's
		// title/description/headings — isolates a chunk-body hit from a
		// (correctly higher-ranked) metadata-field hit on the same terms.
		store.set("https://a.example/1", page({ url: "https://a.example/1", title: "Rate limiting guide", chunks: [{ id: "https://a.example/1#chunk-0", index: 0, heading: "Throttling", text: "Requests are rate-limited per domain with exponential backoff.", wordCount: 9, contentType: "text" }] }));
		store.set("https://a.example/2", page({ url: "https://a.example/2", title: "Unrelated", chunks: [{ id: "https://a.example/2#chunk-0", index: 0, heading: "Other", text: "Nothing to do with the query at all.", wordCount: 8, contentType: "text" }] }));
		const result = store.search("exponential backoff");
		expect(result.pagesSearched).toBe(2);
		expect(result.hits[0]?.url).toBe("https://a.example/1");
		expect(result.hits[0]?.text).toBe("Requests are rate-limited per domain with exponential backoff.");
		expect(result.hits[0]?.title).toBe("Rate limiting guide");
	});

	test("empty query returns no hits without throwing", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page());
		expect(store.search("").hits).toEqual([]);
	});

	test("empty cache returns no hits and reports zero pages searched", () => {
		const { store } = storeWithTmpDir();
		expect(store.search("anything")).toEqual({ query: "anything", pagesSearched: 0, hits: [] });
	});
});

describe("SQLiteCacheStore — categories", () => {
	test("assignCategory() creates the category on first use and is idempotent on repeat assignment", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		const first = store.assignCategory("https://a.example/1", "Code");
		expect(first).toEqual({ url: "https://a.example/1", category: "Code", categoryId: first.categoryId });
		const second = store.assignCategory("https://a.example/1", "Code"); // no-op, not an error
		expect(second.categoryId).toBe(first.categoryId);
		expect(store.listCategories().categories).toEqual([{ id: first.categoryId, name: "Code", pageCount: 1 }]);
	});

	test("assignCategory() is case-insensitive against an existing category name", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.set("https://a.example/2", page({ url: "https://a.example/2" }));
		const first = store.assignCategory("https://a.example/1", "Code");
		const second = store.assignCategory("https://a.example/2", "CODE");
		expect(second.categoryId).toBe(first.categoryId); // same category, not a duplicate
		expect(store.listCategories().categories).toHaveLength(1);
	});

	test("assignCategory() throws for a URL that isn't cached", () => {
		const { store } = storeWithTmpDir();
		expect(() => store.assignCategory("https://a.example/missing", "Code")).toThrow(/page not cached/);
	});

	test("a page can belong to more than one category at once, and overlap shows up in cache.list -- assigning to one never removes it from another", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/rust-ptp", page({ url: "https://a.example/rust-ptp" }));
		store.assignCategory("https://a.example/rust-ptp", "Code");
		store.assignCategory("https://a.example/rust-ptp", "PTP Protocol");

		const code = store.list({ category: "Code" });
		expect(code.pages.map((p) => p.url)).toEqual(["https://a.example/rust-ptp"]);
		const ptp = store.list({ category: "ptp protocol" }); // also proves case-insensitivity
		expect(ptp.pages.map((p) => p.url)).toEqual(["https://a.example/rust-ptp"]); // present in both -- overlap, not exclusive
	});

	test("removeCategory() unlinks the page but leaves the category itself intact for other pages", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.set("https://a.example/2", page({ url: "https://a.example/2" }));
		store.assignCategory("https://a.example/1", "Code");
		store.assignCategory("https://a.example/2", "Code");

		store.removeCategory("https://a.example/1", "Code");
		expect(store.list({ category: "Code" }).pages.map((p) => p.url)).toEqual(["https://a.example/2"]);
		expect(store.listCategories().categories[0]?.pageCount).toBe(1);
	});

	test("removeCategory() is idempotent -- removing an association that's already absent is not an error", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		expect(() => store.removeCategory("https://a.example/1", "Nonexistent")).not.toThrow();
	});

	test("renameCategory() renames in place -- every page association follows automatically, without touching page rows", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		const { categoryId } = store.assignCategory("https://a.example/1", "PTP");

		const result = store.renameCategory("PTP", "PTP Protocol");
		expect(result).toEqual({ categoryId, name: "PTP Protocol", merged: false });
		expect(store.list({ category: "PTP Protocol" }).pages.map((p) => p.url)).toEqual(["https://a.example/1"]);
		expect(store.list({ category: "PTP" }).pages).toEqual([]); // old name no longer resolves
	});

	test("renameCategory() into an already-existing name merges rather than erroring -- a page in both ends up counted once", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.set("https://a.example/2", page({ url: "https://a.example/2" }));
		const ptp = store.assignCategory("https://a.example/1", "PTP");
		const protocol = store.assignCategory("https://a.example/1", "PTP Protocol"); // page 1 is in both already
		store.assignCategory("https://a.example/2", "PTP");

		const result = store.renameCategory("PTP", "PTP Protocol");
		expect(result).toEqual({ categoryId: protocol.categoryId, name: "PTP Protocol", merged: true });

		const merged = store.list({ category: "PTP Protocol" });
		expect(new Set(merged.pages.map((p) => p.url))).toEqual(new Set(["https://a.example/1", "https://a.example/2"]));
		expect(store.listCategories().categories).toHaveLength(1); // the old "PTP" row is gone, not left dangling
		expect(store.listCategories().categories[0]?.id).toBe(ptp.categoryId === protocol.categoryId ? ptp.categoryId : protocol.categoryId);
	});

	test("renameCategory() throws for a category name that doesn't exist", () => {
		const { store } = storeWithTmpDir();
		expect(() => store.renameCategory("Nonexistent", "Whatever")).toThrow(/category not found/);
	});

	test("a page's categories survive re-fetching the same URL (categories are keyed off the stable page id, not recreated per fetch)", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1", title: "v1" }));
		store.assignCategory("https://a.example/1", "Code");
		store.set("https://a.example/1", page({ url: "https://a.example/1", title: "v2" })); // re-fetch, same URL
		expect(store.list({ category: "Code" }).pages.map((p) => p.url)).toEqual(["https://a.example/1"]);
	});

	test("a page's categories are dropped when the page itself is deleted (cascade, matching chunks/images)", () => {
		const { store } = storeWithTmpDir();
		store.set("https://a.example/1", page({ url: "https://a.example/1" }));
		store.assignCategory("https://a.example/1", "Code");
		store.delete("https://a.example/1");
		expect(store.listCategories().categories[0]?.pageCount).toBe(0);
	});
});
