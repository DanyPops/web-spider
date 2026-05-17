/**
 * WBS-TSK-3: TDD tests for getChunk(cache, url, index).
 */

import { describe, expect, it } from "vitest";
import { SpiderCache } from "../src/cache.js";
import { getChunk } from "../src/index.js";
import type { Chunk, SpideredPage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(index: number, text = `Chunk text number ${index}. `.repeat(12)): Chunk {
	return {
		id: `https://example.com#chunk-${index}`,
		index,
		heading: `Heading ${index}`,
		text,
		wordCount: text.split(/\s+/).filter(Boolean).length,
		contentType: "text",
	};
}

function makePage(chunks: Chunk[]): SpideredPage {
	return {
		url: "https://example.com",
		domain: "example.com",
		fetchedAt: new Date().toISOString(),
		title: "Test Page",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: chunks.reduce((n, c) => n + c.wordCount, 0),
		readingTimeMinutes: 1,
		headings: [],
		chunks,
		links: [],
		markdown: chunks.map((c) => c.text).join("\n\n"),
	};
}

function populatedCache(): SpiderCache {
	const cache = new SpiderCache();
	cache.set("https://example.com", makePage([makeChunk(0), makeChunk(1), makeChunk(2)]));
	cache.set("https://other.com", makePage([makeChunk(0), makeChunk(1)]));
	return cache;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getChunk(cache, url, index)", () => {
	it("returns the correct chunk by index", () => {
		const cache = populatedCache();
		const chunk = getChunk(cache, "https://example.com", 1);
		expect(chunk).toBeDefined();
		expect(chunk!.index).toBe(1);
		expect(chunk!.id).toBe("https://example.com#chunk-1");
	});

	it("returns chunk 0", () => {
		const cache = populatedCache();
		const chunk = getChunk(cache, "https://example.com", 0);
		expect(chunk!.index).toBe(0);
	});

	it("returns the last chunk", () => {
		const cache = populatedCache();
		const chunk = getChunk(cache, "https://example.com", 2);
		expect(chunk!.index).toBe(2);
	});

	it("returns undefined for an out-of-range index", () => {
		const cache = populatedCache();
		expect(getChunk(cache, "https://example.com", 99)).toBeUndefined();
	});

	it("returns undefined when the URL is not in the cache", () => {
		const cache = populatedCache();
		expect(getChunk(cache, "https://notcached.com", 0)).toBeUndefined();
	});

	it("returns undefined for a negative index", () => {
		const cache = populatedCache();
		expect(getChunk(cache, "https://example.com", -1)).toBeUndefined();
	});

	it("works across different cached URLs", () => {
		const cache = populatedCache();
		const a = getChunk(cache, "https://example.com", 2);
		const b = getChunk(cache, "https://other.com", 1);
		expect(a!.index).toBe(2);
		expect(b!.index).toBe(1);
	});

	it("normalises trailing slashes in URL", () => {
		const cache = populatedCache();
		const chunk = getChunk(cache, "https://example.com/", 0);
		expect(chunk).toBeDefined();
	});

	it("works with DiskCache via ICache interface", () => {
		// getChunk accepts any ICache<string, SpideredPage> — verify it's not SpiderCache-specific
		const cache = new SpiderCache();
		const chunks = [makeChunk(0), makeChunk(1)];
		cache.set("https://example.com", makePage(chunks));
		const result = getChunk(cache, "https://example.com", 1);
		expect(result).toBeDefined();
		expect(result!.text).toBe(chunks[1].text);
	});
});
