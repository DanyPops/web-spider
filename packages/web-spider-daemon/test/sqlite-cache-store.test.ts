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
	return { store: new SQLiteCacheStore(db, { imagesDir }), imagesDir };
}

describe("pageKey", () => {
	test("strips the hash and trailing slash", () => {
		expect(pageKey("https://example.com/a/#section")).toBe("https://example.com/a");
	});
	test("falls back to the raw string for unparseable input", () => {
		expect(pageKey("not a url")).toBe("not a url");
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
