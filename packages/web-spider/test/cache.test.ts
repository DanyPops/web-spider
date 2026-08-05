import { describe, expect, it } from "vitest";
import { SpiderCache } from "../src/cache/cache.js";
import type { SpideredPage } from "../src/types.js";

function page(url: string): SpideredPage {
	return {
		url,
		domain: "example.com",
		fetchedAt: new Date().toISOString(),
		title: "T",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 1,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: [],
		markdown: "",
	};
}

describe("SpiderCache — URL key normalization", () => {
	it("set() with one query-param order then get() with a different order hits the same entry", () => {
		const cache = new SpiderCache();
		cache.set("https://example.com/search?b=2&a=1", page("https://example.com/search?b=2&a=1"));
		expect(cache.get("https://example.com/search?a=1&b=2")).toBeDefined();
	});

	it("treats a trailing slash and a fragment as the same entry", () => {
		const cache = new SpiderCache();
		cache.set("https://example.com/docs/", page("https://example.com/docs/"));
		expect(cache.get("https://example.com/docs#section")).toBeDefined();
	});
});
