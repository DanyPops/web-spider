import { describe, expect, test } from "bun:test";
import type { ICache, SpideredPage } from "@danypops/web-spider";
import { withMaxAge } from "../src/cache/freshness-view.ts";

function fakePage(overrides: Partial<SpideredPage> = {}): SpideredPage {
	return {
		url: "https://x.test",
		domain: "x.test",
		fetchedAt: new Date().toISOString(),
		title: "",
		description: "",
		author: "",
		publishedAt: "",
		lang: "",
		tags: [],
		wordCount: 0,
		readingTimeMinutes: 0,
		headings: [],
		links: [],
		chunks: [],
		markdown: "",
		...overrides,
	} as SpideredPage;
}

function fakeInnerCache(): ICache<string, SpideredPage> & { store: Map<string, SpideredPage> } {
	const store = new Map<string, SpideredPage>();
	return {
		store,
		get: (url) => store.get(url),
		set: (url, page) => void store.set(url, page),
		has: (url) => store.has(url),
		delete: (url) => void store.delete(url),
		values: () => [...store.values()],
	};
}

describe("withMaxAge", () => {
	test("get()/has() report a fresh entry (age < maxAgeMs) normally", () => {
		const inner = fakeInnerCache();
		inner.set("https://x.test", fakePage({ fetchedAt: new Date(Date.now() - 1_000).toISOString() }));
		const view = withMaxAge(inner, 60_000);
		expect(view.has("https://x.test")).toBe(true);
		expect(view.get("https://x.test")).toBeDefined();
	});

	test("get()/has() report a stale entry (age >= maxAgeMs) as absent", () => {
		const inner = fakeInnerCache();
		inner.set("https://x.test", fakePage({ fetchedAt: new Date(Date.now() - 120_000).toISOString() }));
		const view = withMaxAge(inner, 60_000);
		expect(view.has("https://x.test")).toBe(false);
		expect(view.get("https://x.test")).toBeUndefined();
	});

	test("maxAgeMs: 0 always treats even a same-instant entry as stale", () => {
		const inner = fakeInnerCache();
		inner.set("https://x.test", fakePage({ fetchedAt: new Date().toISOString() }));
		const view = withMaxAge(inner, 0);
		expect(view.has("https://x.test")).toBe(false);
	});

	test("an unparseable fetchedAt fails closed (never fresh)", () => {
		const inner = fakeInnerCache();
		inner.set("https://x.test", fakePage({ fetchedAt: "not-a-date" }));
		const view = withMaxAge(inner, 1_000_000);
		expect(view.has("https://x.test")).toBe(false);
	});

	test("set() delegates straight through to the inner cache, unaffected by maxAgeMs", () => {
		const inner = fakeInnerCache();
		const view = withMaxAge(inner, 0);
		const page = fakePage({ fetchedAt: new Date().toISOString() });
		view.set("https://x.test", page);
		expect(inner.store.get("https://x.test")).toBe(page);
	});

	test("delete()/values() delegate straight through; values() also filters by freshness", () => {
		const inner = fakeInnerCache();
		inner.set("https://fresh.test", fakePage({ url: "https://fresh.test", fetchedAt: new Date().toISOString() }));
		inner.set("https://stale.test", fakePage({ url: "https://stale.test", fetchedAt: new Date(Date.now() - 999_999).toISOString() }));
		const view = withMaxAge(inner, 1_000);
		expect(view.values().map((p) => p.url)).toEqual(["https://fresh.test"]);

		view.delete("https://fresh.test");
		expect(inner.store.has("https://fresh.test")).toBe(false);
	});

	test('a negative maxAgeMs is clamped to 0, not treated as "always fresh"', () => {
		const inner = fakeInnerCache();
		inner.set("https://x.test", fakePage({ fetchedAt: new Date().toISOString() }));
		const view = withMaxAge(inner, -5_000);
		expect(view.has("https://x.test")).toBe(false);
	});
});
