import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { fuzzySearch } from "../src/search.js";
import type { SpideredPage } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): SpideredPage {
	const raw = readFileSync(join(__dirname, "../fixtures", name), "utf8");
	return JSON.parse(raw) as SpideredPage;
}

const guide = loadFixture("guide-ai-agents-web-scraping.json");

// ---------------------------------------------------------------------------
// Basic contract
// ---------------------------------------------------------------------------

describe("fuzzySearch — contract", () => {
	it("returns an empty array for a blank query", () => {
		expect(fuzzySearch([guide], "")).toEqual([]);
		expect(fuzzySearch([guide], "   ")).toEqual([]);
	});

	it("returns an empty array when no pages are given", () => {
		expect(fuzzySearch([], "openai")).toEqual([]);
	});

	it("returns at most topN results", () => {
		const hits = fuzzySearch([guide], "the", { topN: 3 });
		expect(hits.length).toBeLessThanOrEqual(3);
	});

	it("every hit has required fields", () => {
		const hits = fuzzySearch([guide], "openai");
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) {
			expect(typeof h.url).toBe("string");
			expect(typeof h.chunkId).toBe("string");
			expect(typeof h.heading).toBe("string");
			expect(typeof h.score).toBe("number");
			expect(typeof h.snippet).toBe("string");
		}
	});

	it("scores are in 0–1 range", () => {
		const hits = fuzzySearch([guide], "agent scraping pipeline");
		for (const h of hits) {
			expect(h.score).toBeGreaterThan(0);
			expect(h.score).toBeLessThanOrEqual(1);
		}
	});

	it("results are sorted by score descending", () => {
		const hits = fuzzySearch([guide], "LLM extraction cost");
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
		}
	});
});

// ---------------------------------------------------------------------------
// Exact match quality
// ---------------------------------------------------------------------------

describe("fuzzySearch — exact match", () => {
	it("finds an exact phrase from the fixture title", () => {
		const hits = fuzzySearch([guide], "AI Agents & Web Scraping");
		expect(hits.length).toBeGreaterThan(0);
		const titleHit = hits.find((h) => h.heading === "title");
		expect(titleHit).toBeDefined();
		expect(titleHit!.score).toBeGreaterThan(0.5);
	});

	it("exact match scores higher than partial match for the same chunk", () => {
		// "cost optimization" appears verbatim in a heading
		const exact = fuzzySearch([guide], "Cost Optimization");
		const partial = fuzzySearch([guide], "cost");
		// The heading hit for exact phrase should outrank a generic token hit
		const exactTop = exact[0];
		expect(exactTop.score).toBeGreaterThanOrEqual(partial[0].score);
	});

	it("includes a non-empty snippet for every hit", () => {
		const hits = fuzzySearch([guide], "OpenAI API");
		for (const h of hits) {
			expect(h.snippet.trim().length).toBeGreaterThan(0);
		}
	});

	it("snippet contains the matched term", () => {
		const hits = fuzzySearch([guide], "OpenAI API", { topN: 5 });
		// At least one snippet should contain the matched term (case-insensitive)
		const found = hits.some((h) => h.snippet.toLowerCase().includes("openai"));
		expect(found).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Fuzzy / partial matching
// ---------------------------------------------------------------------------

describe("fuzzySearch — fuzzy matching", () => {
	it("matches partial tokens (prefix)", () => {
		// "automat" should match "automation", "automated", "automatically"
		const hits = fuzzySearch([guide], "automat");
		expect(hits.length).toBeGreaterThan(0);
	});

	it("is case-insensitive", () => {
		const lower = fuzzySearch([guide], "amazon");
		const upper = fuzzySearch([guide], "AMAZON");
		expect(lower.length).toBe(upper.length);
		expect(lower.map((h) => h.chunkId)).toEqual(upper.map((h) => h.chunkId));
	});

	it("handles multi-word queries across chunk boundaries", () => {
		// Words that appear spread across the document, not necessarily adjacent
		const hits = fuzzySearch([guide], "proxy captcha reliable");
		expect(hits.length).toBeGreaterThan(0);
	});

	it("returns no hits for a query that is clearly absent", () => {
		const hits = fuzzySearch([guide], "xyzzy quux frumious bandersnatch");
		expect(hits.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Metadata vs chunk hits
// ---------------------------------------------------------------------------

describe("fuzzySearch — metadata hits", () => {
	it("matches headings and returns chunkId as empty string", () => {
		const hits = fuzzySearch([guide], "Frequently Asked Questions");
		const metaHit = hits.find((h) => h.chunkId === "");
		expect(metaHit).toBeDefined();
	});

	it("chunk hits carry a valid chunk ID", () => {
		const hits = fuzzySearch([guide], "intelligent data pipeline");
		const chunkHit = hits.find((h) => h.chunkId !== "");
		expect(chunkHit).toBeDefined();
		expect(chunkHit!.chunkId).toMatch(/^https?:\/\/.+#chunk-\d+$/);
	});

	it("matches the page description field", () => {
		// Guide description: "Combine AI agents with web scraping APIs..."
		const hits = fuzzySearch([guide], "automated reports");
		expect(hits.some((h) => h.heading === "description")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Multi-page corpus
// ---------------------------------------------------------------------------

describe("fuzzySearch — multi-page corpus", () => {
	// Build a second synthetic page from a subset of the guide's chunks
	const page2: SpideredPage = {
		...guide,
		url: "https://example.com/other",
		domain: "example.com",
		title: "A Different Article About Proxies",
		description: "Proxy rotation and CAPTCHA handling for scrapers.",
		chunks: guide.chunks.slice(0, 2).map((c, i) => ({
			...c,
			id: `https://example.com/other#chunk-${i}`,
		})),
	};

	it("returns hits from multiple pages when both match", () => {
		// topN must exceed the number of matching guide chunks to let page2 surface
		const hits = fuzzySearch([guide, page2], "scraping", { topN: 100 });
		const urls = new Set(hits.map((h) => h.url));
		expect(urls.size).toBeGreaterThan(1);
	});

	it("respects topN across the whole corpus", () => {
		const hits = fuzzySearch([guide, page2], "agent", { topN: 4 });
		expect(hits.length).toBeLessThanOrEqual(4);
	});

	it("higher-scoring page ranks first regardless of input order", () => {
		// page2 title is explicitly about proxies; guide is not
		const hitsProxies = fuzzySearch([guide, page2], "proxy rotation CAPTCHA", { topN: 1 });
		expect(hitsProxies[0].url).toBe(page2.url);
	});
});

// ---------------------------------------------------------------------------
// Snippet shape
// ---------------------------------------------------------------------------

describe("fuzzySearch — snippet", () => {
	it("snippet is bounded by snippetRadius", () => {
		const radius = 30;
		const hits = fuzzySearch([guide], "OpenAI", { snippetRadius: radius });
		for (const h of hits) {
			// Strip leading/trailing ellipsis markers before measuring
			const bare = h.snippet.replace(/^…|…$/g, "");
			// The bare snippet should be at most 2×radius + matched term length
			// Give a generous upper bound to account for word boundaries
			expect(bare.length).toBeLessThan(radius * 2 + 60);
		}
	});

	it("snippet adds leading ellipsis when match is not at start", () => {
		// Search for something known to appear mid-text
		const hits = fuzzySearch([guide], "cost optimization");
		const mid = hits.find((h) => h.snippet.startsWith("…"));
		expect(mid).toBeDefined();
	});
});
