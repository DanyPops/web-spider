/**
 * Unit tests for the web-search strategy layer.
 *
 * No network calls — every ISearchEngine is stubbed so these run offline
 * and exercise the FallbackSearchEngine composition logic in isolation.
 */

import { describe, expect, it, vi } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import { DdgSearchEngine, FallbackSearchEngine, TavilySearchEngine } from "../src/web-search.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESULT_A: WebSearchResult = { url: "https://a.example", title: "A", snippet: "snippet a" };
const RESULT_B: WebSearchResult = { url: "https://b.example", title: "B", snippet: "snippet b" };

/** Stub engine that resolves with a fixed result list. */
function okEngine(results: WebSearchResult[]): ISearchEngine {
	return { search: vi.fn().mockResolvedValue(results) };
}

/** Stub engine that always throws. */
function failEngine(message = "engine error"): ISearchEngine {
	return { search: vi.fn().mockRejectedValue(new Error(message)) };
}

const REQ: SearchQuery = { query: "test query", numResults: 5 };

// ---------------------------------------------------------------------------
// FallbackSearchEngine — construction guards
// ---------------------------------------------------------------------------

describe("FallbackSearchEngine — construction", () => {
	it("throws when constructed with an empty engines array", () => {
		expect(() => new FallbackSearchEngine([])).toThrow("at least one engine");
	});

	it("accepts a single engine", () => {
		expect(() => new FallbackSearchEngine([okEngine([])])).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// FallbackSearchEngine — happy path
// ---------------------------------------------------------------------------

describe("FallbackSearchEngine — first engine succeeds", () => {
	it("returns first engine's results without calling subsequent engines", async () => {
		const first = okEngine([RESULT_A]);
		const second = okEngine([RESULT_B]);
		const fb = new FallbackSearchEngine([first, second]);

		const results = await fb.search(REQ);

		expect(results).toEqual([RESULT_A]);
		expect(first.search).toHaveBeenCalledOnce();
		expect(second.search).not.toHaveBeenCalled();
	});

	it("forwards query and numResults to the engine", async () => {
		const engine = okEngine([RESULT_A]);
		const fb = new FallbackSearchEngine([engine]);
		const req: SearchQuery = { query: "hello", numResults: 3 };

		await fb.search(req);

		expect(engine.search).toHaveBeenCalledWith(req);
	});
});

// ---------------------------------------------------------------------------
// FallbackSearchEngine — fallbackOnEmpty (default: true)
// ---------------------------------------------------------------------------

describe("FallbackSearchEngine — fallbackOnEmpty", () => {
	it("falls through to second engine when first returns empty (default)", async () => {
		const first = okEngine([]);
		const second = okEngine([RESULT_B]);
		const fb = new FallbackSearchEngine([first, second]);

		const results = await fb.search(REQ);

		expect(results).toEqual([RESULT_B]);
		expect(first.search).toHaveBeenCalledOnce();
		expect(second.search).toHaveBeenCalledOnce();
	});

	it("does NOT fall through when fallbackOnEmpty is false", async () => {
		const first = okEngine([]);
		const second = okEngine([RESULT_B]);
		const fb = new FallbackSearchEngine([first, second], { fallbackOnEmpty: false });

		const results = await fb.search(REQ);

		expect(results).toEqual([]);
		expect(second.search).not.toHaveBeenCalled();
	});

	it("returns empty when all engines return empty", async () => {
		const fb = new FallbackSearchEngine([okEngine([]), okEngine([])]);
		const results = await fb.search(REQ);
		expect(results).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// FallbackSearchEngine — fallbackOnError (default: true)
// ---------------------------------------------------------------------------

describe("FallbackSearchEngine — fallbackOnError", () => {
	it("falls through to next engine on error (default)", async () => {
		const first = failEngine("network timeout");
		const second = okEngine([RESULT_B]);
		const fb = new FallbackSearchEngine([first, second]);

		const results = await fb.search(REQ);

		expect(results).toEqual([RESULT_B]);
		expect(second.search).toHaveBeenCalledOnce();
	});

	it("re-throws immediately when fallbackOnError is false", async () => {
		const first = failEngine("api key invalid");
		const second = okEngine([RESULT_B]);
		const fb = new FallbackSearchEngine([first, second], { fallbackOnError: false });

		await expect(fb.search(REQ)).rejects.toThrow("api key invalid");
		expect(second.search).not.toHaveBeenCalled();
	});

	it("re-throws last error when all engines fail", async () => {
		const fb = new FallbackSearchEngine([
			failEngine("first error"),
			failEngine("second error"),
		]);

		await expect(fb.search(REQ)).rejects.toThrow("second error");
	});

	it("falls through on error then on empty before returning results", async () => {
		const first = failEngine("timeout");
		const second = okEngine([]);
		const third = okEngine([RESULT_A]);
		const fb = new FallbackSearchEngine([first, second, third]);

		const results = await fb.search(REQ);

		expect(results).toEqual([RESULT_A]);
		expect(third.search).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// FallbackSearchEngine — composability (nested)
// ---------------------------------------------------------------------------

describe("FallbackSearchEngine — composability", () => {
	it("can be nested inside another FallbackSearchEngine", async () => {
		// Inner chain: fails → empty
		const inner = new FallbackSearchEngine([failEngine(), okEngine([])]);
		// Outer chain: inner → RESULT_B
		const outer = new FallbackSearchEngine([inner, okEngine([RESULT_B])]);

		const results = await outer.search(REQ);
		expect(results).toEqual([RESULT_B]);
	});

	it("implements ISearchEngine — assignable to the port type", () => {
		const fb: ISearchEngine = new FallbackSearchEngine([okEngine([])]);
		expect(typeof fb.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// DdgSearchEngine — port conformance (no network)
// ---------------------------------------------------------------------------

describe("DdgSearchEngine — port conformance", () => {
	it("implements ISearchEngine", () => {
		const engine: ISearchEngine = new DdgSearchEngine();
		expect(typeof engine.search).toBe("function");
	});

	it("can be placed inside a FallbackSearchEngine chain", async () => {
		// We don't call the real DDG here — just assert structural compatibility.
		const ddg = new DdgSearchEngine();
		const fb = new FallbackSearchEngine([okEngine([RESULT_A]), ddg]);

		// First engine returns results — DDG never called (no network needed)
		const results = await fb.search(REQ);
		expect(results).toEqual([RESULT_A]);
	});
});

// ---------------------------------------------------------------------------
// TavilySearchEngine — missing key throws (guards)
// ---------------------------------------------------------------------------

describe("TavilySearchEngine — key guard", () => {
	it("throws when no API key is provided and env var is absent", async () => {
		const savedKey = process.env["TAVILY_API_KEY"];
		delete process.env["TAVILY_API_KEY"];

		const engine = new TavilySearchEngine(""); // empty string = no key
		await expect(engine.search(REQ)).rejects.toThrow();

		if (savedKey !== undefined) process.env["TAVILY_API_KEY"] = savedKey;
	});
});

// ---------------------------------------------------------------------------
// Recommended composition: Tavily → DDG
// ---------------------------------------------------------------------------

describe("Tavily + DDG fallback pattern", () => {
	it("returns Tavily results when Tavily succeeds", async () => {
		const tavily = okEngine([RESULT_A]);
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_A]);
		expect(ddg.search).not.toHaveBeenCalled();
	});

	it("falls back to DDG when Tavily returns empty", async () => {
		const tavily = okEngine([]);
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_B]);
	});

	it("falls back to DDG when Tavily throws (e.g. rate limit)", async () => {
		const tavily = failEngine("429 rate limit");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_B]);
	});

	it("returns empty when both Tavily and DDG find nothing", async () => {
		const engine = new FallbackSearchEngine([okEngine([]), okEngine([])]);
		const results = await engine.search(REQ);
		expect(results).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SearchQuery — timeRange and topic fields
// ---------------------------------------------------------------------------

describe("SearchQuery — timeRange and topic", () => {
	it("SearchQuery accepts timeRange field", () => {
		const req: SearchQuery = { query: "AI agents", numResults: 5, timeRange: "month" };
		expect(req.timeRange).toBe("month");
	});

	it("SearchQuery accepts topic field", () => {
		const req: SearchQuery = { query: "latest news", topic: "news" };
		expect(req.topic).toBe("news");
	});

	it("FallbackSearchEngine forwards timeRange and topic to each engine", async () => {
		const spy = vi.fn().mockResolvedValue([RESULT_A]);
		const engine = new FallbackSearchEngine([{ search: spy }]);

		await engine.search({ query: "test", timeRange: "week", topic: "news" });

		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ timeRange: "week", topic: "news" }),
		);
	});

	it("TavilySearchEngine.search() sends time_range and topic in the POST body", async () => {
		// Intercept global fetch to capture what body Tavily receives.
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string ?? "{}");
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({
					results: [{ url: "https://a.com", title: "A", content: "snippet" }],
				}),
			};
		}) as typeof fetch;

		try {
			const engine = new TavilySearchEngine("test-key");
			await engine.search({ query: "ona", timeRange: "month", topic: "news" });
			expect(capturedBody).toMatchObject({ time_range: "month", topic: "news" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
