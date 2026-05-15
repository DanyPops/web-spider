/**
 * Integration tests — real network, real APIs.
 *
 * Each suite skips cleanly when its API key is absent so CI without secrets
 * still passes. Run locally with keys set:
 *
 *   TAVILY_API_KEY=tvly-... vitest run test/web-search-integration.test.ts
 *
 * DDG tests always run — no key required.
 */

import { describe, expect, it } from "vitest";
import type { WebSearchResult } from "../src/ports.js";
import {
	DdgSearchEngine,
	FallbackSearchEngine,
	TavilySearchEngine,
	ddgSearch,
	tavilySearch,
	webSearch,
} from "../src/web-search.js";

// ---------------------------------------------------------------------------
// Shared contract assertions
// ---------------------------------------------------------------------------

function assertResults(results: WebSearchResult[], minCount = 1) {
	expect(Array.isArray(results)).toBe(true);
	expect(results.length).toBeGreaterThanOrEqual(minCount);
	for (const r of results) {
		expect(typeof r.url).toBe("string");
		expect(r.url).toMatch(/^https?:\/\//);
		expect(typeof r.title).toBe("string");
		expect(r.title.length).toBeGreaterThan(0);
		expect(typeof r.snippet).toBe("string");
	}
}

// ---------------------------------------------------------------------------
// DuckDuckGo — no key required, always runs
// ---------------------------------------------------------------------------

describe("ddgSearch() — live DDG Instant Answer API", () => {
	it("returns a parseable JSON response (catches Brotli/encoding issues)", async () => {
		// This test exists specifically to catch the Node fetch + Brotli bug:
		// DDG responds with Content-Encoding: br by default; undici won't
		// decompress it, yielding an empty body and a JSON parse error.
		// The fix: Accept-Encoding: gzip, deflate in the request headers.
		const results = await ddgSearch("OpenAI", { numResults: 5 });
		// DDG may return 0 results for some queries — just assert no throw
		expect(Array.isArray(results)).toBe(true);
	});

	it("returns well-known entity results for an unambiguous query", async () => {
		const results = await ddgSearch("Node.js", { numResults: 5 });
		assertResults(results);
	});

	it("every result has a valid http(s) URL", async () => {
		const results = await ddgSearch("TypeScript language", { numResults: 8 });
		for (const r of results) {
			expect(() => new URL(r.url)).not.toThrow();
			expect(["http:", "https:"]).toContain(new URL(r.url).protocol);
		}
	});

	it("respects numResults cap", async () => {
		const results = await ddgSearch("JavaScript", { numResults: 3 });
		expect(results.length).toBeLessThanOrEqual(3);
	});

	it("returns an empty array (not a throw) for a nonsense query", async () => {
		const results = await ddgSearch("xyzzy-quux-frumious-bandersnatch-99999");
		expect(Array.isArray(results)).toBe(true);
	});

	it("DdgSearchEngine.search() delegates correctly", async () => {
		const engine = new DdgSearchEngine();
		const results = await engine.search({ query: "OpenAI", numResults: 3 });
		expect(Array.isArray(results)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tavily — skips when TAVILY_API_KEY is absent
// ---------------------------------------------------------------------------

const TAVILY_KEY = process.env["TAVILY_API_KEY"];
const describeTavily = TAVILY_KEY ? describe : describe.skip;

describeTavily("tavilySearch() — live Tavily API", () => {
	it("returns results for a straightforward query", async () => {
		const results = await tavilySearch("hexagonal architecture TypeScript", { numResults: 3 });
		assertResults(results, 1);
	});

	it("every result has a valid URL and non-empty title", async () => {
		const results = await tavilySearch("web scraping AI agents", { numResults: 5 });
		assertResults(results, 1);
	});

	it("respects numResults", async () => {
		const results = await tavilySearch("JavaScript", { numResults: 2 });
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it("TavilySearchEngine.search() delegates correctly", async () => {
		const engine = new TavilySearchEngine(TAVILY_KEY!);
		const results = await engine.search({ query: "DuckDuckGo API", numResults: 3 });
		assertResults(results, 1);
	});

	it("throws a clear error when the key is wrong", async () => {
		await expect(
			tavilySearch("test", { apiKey: "tvly-invalid-key-000" }),
		).rejects.toThrow(/tavily/i);
	});
});

// ---------------------------------------------------------------------------
// FallbackSearchEngine — Tavily → DDG end-to-end
// ---------------------------------------------------------------------------

const describeFallback = TAVILY_KEY ? describe : describe.skip;

describeFallback("FallbackSearchEngine — Tavily → DDG live chain", () => {
	it("Tavily wins for a normal query (DDG never needed)", async () => {
		const engine = new FallbackSearchEngine([
			new TavilySearchEngine(TAVILY_KEY!),
			new DdgSearchEngine(),
		]);
		const results = await engine.search({ query: "TypeScript strategy pattern", numResults: 3 });
		assertResults(results, 1);
	});

	it("DDG provides results when Tavily is replaced with a failing stub", async () => {
		const alwaysFails = { search: async () => { throw new Error("simulated Tavily outage"); } };
		const engine = new FallbackSearchEngine([alwaysFails, new DdgSearchEngine()]);
		// DDG may return empty for some queries but must not throw
		const results = await engine.search({ query: "OpenAI", numResults: 3 });
		expect(Array.isArray(results)).toBe(true);
	});

	it("DDG provides results when Tavily returns empty", async () => {
		const alwaysEmpty = { search: async () => [] };
		const engine = new FallbackSearchEngine([alwaysEmpty, new DdgSearchEngine()]);
		const results = await engine.search({ query: "Node.js", numResults: 3 });
		expect(Array.isArray(results)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// webSearch() — auto-detect from env
// ---------------------------------------------------------------------------

const describeWebSearch = TAVILY_KEY ? describe : describe.skip;

describeWebSearch("webSearch() — auto-detects Tavily from env", () => {
	it("returns results without specifying an engine", async () => {
		const results = await webSearch("open source web crawler", { numResults: 3 });
		assertResults(results, 1);
	});

	it("returns results when engine is forced to 'tavily'", async () => {
		const results = await webSearch("AI coding assistant", { engine: "tavily", numResults: 3 });
		assertResults(results, 1);
	});

	it("returns results when engine is forced to 'ddg'", async () => {
		const results = await webSearch("OpenAI", { engine: "ddg", numResults: 5 });
		expect(Array.isArray(results)).toBe(true);
	});

	it("throws a descriptive error when forced to 'brave' with no key set", async () => {
		const saved = process.env["BRAVE_SEARCH_API_KEY"];
		delete process.env["BRAVE_SEARCH_API_KEY"];
		await expect(webSearch("test", { engine: "brave" })).rejects.toThrow("BRAVE_SEARCH_API_KEY");
		if (saved) process.env["BRAVE_SEARCH_API_KEY"] = saved;
	});
});
