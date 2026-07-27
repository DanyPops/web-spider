/**
 * Integration tests — real network, real APIs.
 *
 * Each suite skips cleanly when its API key is absent so CI without secrets
 * still passes. Run locally with keys set:
 *
 *   TAVILY_API_KEY=tvly-... vitest run test/web-search-integration.test.ts
 */

import { describe, expect, it } from "vitest";
import type { WebSearchResult } from "../src/ports.js";
import {
	TavilySearchEngine,
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
		const results = await engine.search({ query: "hexagonal architecture", numResults: 3 });
		assertResults(results, 1);
	});

	it("throws a clear error when the key is wrong", async () => {
		await expect(
			tavilySearch("test", { apiKey: "tvly-invalid-key-000" }),
		).rejects.toThrow(/tavily/i);
	});
});

// FallbackSearchEngine composition (empty/error → next engine, cooldown,
// onEngineFailure classification) is covered against stub engines in
// web-search.test.ts — no live-network fallback chain to test here since
// there's no keyless engine left to compose Tavily with.

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

	it("throws a descriptive error when forced to 'brave' with no key set", async () => {
		const saved = process.env["BRAVE_SEARCH_API_KEY"];
		delete process.env["BRAVE_SEARCH_API_KEY"];
		await expect(webSearch("test", { engine: "brave" })).rejects.toThrow("BRAVE_SEARCH_API_KEY");
		if (saved) process.env["BRAVE_SEARCH_API_KEY"] = saved;
	});
});
