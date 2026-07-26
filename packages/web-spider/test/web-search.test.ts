/**
 * Unit tests for the web-search strategy layer.
 *
 * No network calls — every ISearchEngine is stubbed so these run offline
 * and exercise the FallbackSearchEngine composition logic in isolation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import { DdgSearchEngine, FallbackSearchEngine, RoundRobinSearchEngine, SerpApiSearchEngine, SerperSearchEngine, TavilySearchEngine, defaultSearchEngine, isLikelyRateLimitError, serpApiSearch, serperSearch } from "../src/web-search.js";

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

	it("returns empty (not Tavily's stale error) when Tavily throws and DDG then succeeds with zero hits", async () => {
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([]);
		const engine = new FallbackSearchEngine([tavily, ddg]);

		await expect(engine.search(REQ)).resolves.toEqual([]);
	});
});

describe("FallbackSearchEngine — rate-limit cooldown", () => {
	it("skips an engine on the next call after a rate-limit-shaped failure, within the cooldown window", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1);

		now += 1_000; // still within the cooldown window
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1); // not called again -- skipped
		expect(ddg.search).toHaveBeenCalledTimes(2);
	});

	it("retries the engine again once the cooldown window elapses", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		now += 60_001;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("does not cool down on a non-rate-limit error -- retries every call", async () => {
		let now = 0;
		const tavily = failEngine("highlights format requires a query");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("cooldownMs: 0 disables cooldown entirely", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], { cooldownMs: 0, now: () => now });

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("a custom isRateLimitError predicate overrides the default heuristic", async () => {
		let now = 0;
		const tavily = failEngine("weird provider-specific overload code");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], {
			cooldownMs: 60_000,
			now: () => now,
			isRateLimitError: (err) => err instanceof Error && err.message.includes("overload"),
		});

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1); // skipped on the 2nd call
	});
});

describe("FallbackSearchEngine — onEngineFailure", () => {
	it("reports an engine's own index, error, and reason:\"error\" when it throws", async () => {
		const calls: Array<{ index: number; reason: string }> = [];
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], {
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await engine.search(REQ);
		expect(calls).toEqual([{ index: 0, reason: "error" }]);
	});

	it("reports reason:\"cooldown\" for an engine skipped without ever being called", async () => {
		let now = 0;
		const calls: Array<{ index: number; reason: string }> = [];
		const tavily = failEngine("Tavily API error: 432");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, ddg], {
			cooldownMs: 60_000,
			now: () => now,
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(calls).toEqual([{ index: 0, reason: "error" }, { index: 0, reason: "cooldown" }]);
		expect(tavily.search).toHaveBeenCalledTimes(1);
	});

	it("is never called for a genuine empty result", async () => {
		const calls: unknown[] = [];
		const engine = new FallbackSearchEngine([okEngine([]), okEngine([])], {
			onEngineFailure: (...args) => { calls.push(args); },
		});

		await engine.search(REQ);
		expect(calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RoundRobinSearchEngine
// ---------------------------------------------------------------------------

describe("RoundRobinSearchEngine — construction", () => {
	it("throws when constructed with an empty engines array", () => {
		expect(() => new RoundRobinSearchEngine([])).toThrow(/at least one engine/);
	});

	it("accepts a single engine", async () => {
		const engine = new RoundRobinSearchEngine([okEngine([RESULT_A])]);
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_A]);
	});
});

describe("RoundRobinSearchEngine — rotation", () => {
	it("calls each engine in order across successive calls", async () => {
		const a = okEngine([RESULT_A]);
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b]);

		await expect(engine.search(REQ)).resolves.toEqual([RESULT_A]);
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_B]);
		expect(a.search).toHaveBeenCalledTimes(1);
		expect(b.search).toHaveBeenCalledTimes(1);
	});

	it("wraps around after the last engine", async () => {
		const a = okEngine([RESULT_A]);
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b]);

		await engine.search(REQ); // a
		await engine.search(REQ); // b
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_A]); // back to a
		expect(a.search).toHaveBeenCalledTimes(2);
		expect(b.search).toHaveBeenCalledTimes(1);
	});

	it("never calls an engine it didn't rotate to on a given call", async () => {
		const a = okEngine([RESULT_A]);
		const b = okEngine([RESULT_B]);
		const c = okEngine([]);
		const engine = new RoundRobinSearchEngine([a, b, c]);

		await engine.search(REQ);
		expect(a.search).toHaveBeenCalledTimes(1);
		expect(b.search).not.toHaveBeenCalled();
		expect(c.search).not.toHaveBeenCalled();
	});
});

describe("RoundRobinSearchEngine — no fallback of its own", () => {
	it("propagates the picked engine's error untouched, without trying the next engine", async () => {
		const a = failEngine("engine a down");
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b]);

		await expect(engine.search(REQ)).rejects.toThrow("engine a down");
		expect(b.search).not.toHaveBeenCalled();
	});

	it("returns the picked engine's empty result untouched, without trying the next engine", async () => {
		const a = okEngine([]);
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b]);

		await expect(engine.search(REQ)).resolves.toEqual([]);
		expect(b.search).not.toHaveBeenCalled();
	});

	it("still advances the rotation cursor even when the picked engine throws", async () => {
		const a = failEngine("engine a down");
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b]);

		await expect(engine.search(REQ)).rejects.toThrow();
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_B]);
	});
});

describe("RoundRobinSearchEngine — composability inside FallbackSearchEngine", () => {
	it("a failure from the rotated-to engine still falls through to the outer FallbackSearchEngine's next entry", async () => {
		const a = failEngine("engine a down");
		const b = failEngine("engine b down");
		const ddg = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([new RoundRobinSearchEngine([a, b]), ddg]);

		await expect(engine.search(REQ)).resolves.toEqual([RESULT_B]);
	});

	it("implements ISearchEngine — assignable to the port type", () => {
		const engine: ISearchEngine = new RoundRobinSearchEngine([okEngine([])]);
		expect(typeof engine.search).toBe("function");
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

// ---------------------------------------------------------------------------
// isLikelyRateLimitError
// ---------------------------------------------------------------------------

describe("isLikelyRateLimitError", () => {
	it("treats a standard 429 message as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("Brave Search API error: 429 Too Many Requests"))).toBe(true);
	});

	it("treats Tavily's non-standard 432 as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("Tavily API error: 432"))).toBe(true);
	});

	it("treats quota/rate-limit-shaped message text as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("quota exceeded for this API key"))).toBe(true);
		expect(isLikelyRateLimitError(new Error("rate limit exceeded, try again later"))).toBe(true);
	});

	it("does not treat a genuine domain-level error as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("highlights format requires a query"))).toBe(false);
	});

	it("does not treat a non-Error value as a rate limit", () => {
		expect(isLikelyRateLimitError("432")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// defaultSearchEngine — engine-name mapping for onEngineFailure
// ---------------------------------------------------------------------------

describe("defaultSearchEngine — onEngineFailure engine names", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("reports the failing engine by name (tavily), not by array index", async () => {
		process.env["TAVILY_API_KEY"] = "fake-key";
		delete process.env["BRAVE_SEARCH_API_KEY"];
		delete process.env["EXA_API_KEY"];
		delete process.env["SERPER_API_KEY"];
		delete process.env["SERPAPI_API_KEY"];

		const calls: Array<{ name: string; reason: string }> = [];
		const engine = defaultSearchEngine({ onEngineFailure: (name, _error, reason) => { calls.push({ name, reason }); } });

		// Every provider is unreachable here (fetch always 432s) -- DDG fails too,
		// so the chain as a whole still rejects; only the first (Tavily) entry matters for this assertion.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("rate limited", { status: 432, statusText: "Usage Limit Exceeded" })) as typeof fetch;
		try {
			await expect(engine.search({ query: "test" })).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(calls[0]).toEqual({ name: "tavily", reason: "error" });
	});
});

// ---------------------------------------------------------------------------
// serperSearch / SerperSearchEngine
// ---------------------------------------------------------------------------

describe("serperSearch", () => {
	it("throws when no API key is provided and env var is absent", async () => {
		delete process.env["SERPER_API_KEY"];
		await expect(serperSearch("test")).rejects.toThrow(/Serper API key required/);
	});

	it("POSTs to google.serper.dev/search with X-API-KEY header and {q} body", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ organic: [{ title: "T", link: "https://a.example", snippet: "s" }] }),
			};
		}) as typeof fetch;

		try {
			await serperSearch("coffee", { apiKey: "test-key", numResults: 5 });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(capturedUrl).toBe("https://google.serper.dev/search");
		expect(capturedInit?.method).toBe("POST");
		expect((capturedInit?.headers as Record<string, string>)["X-API-KEY"]).toBe("test-key");
		expect(JSON.parse(capturedInit?.body as string)).toEqual({ q: "coffee", num: 5 });
	});

	it("maps organic[] to WebSearchResult[]", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({
				organic: [{ title: "A", link: "https://a.example", snippet: "snippet a", date: "2024-01-01" }],
			}),
		}) as unknown as typeof fetch;

		try {
			const results = await serperSearch("test", { apiKey: "key" });
			expect(results).toEqual([{ url: "https://a.example", title: "A", snippet: "snippet a", publishedAt: "2024-01-01" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws a descriptive error on a non-2xx response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" }) as unknown as typeof fetch;
		try {
			await expect(serperSearch("test", { apiKey: "key" })).rejects.toThrow(/Serper API error: 429/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("SerperSearchEngine — port conformance", () => {
	it("implements ISearchEngine", () => {
		const engine: ISearchEngine = new SerperSearchEngine("key");
		expect(typeof engine.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// serpApiSearch / SerpApiSearchEngine
// ---------------------------------------------------------------------------

describe("serpApiSearch", () => {
	it("throws when no API key is provided and env var is absent", async () => {
		delete process.env["SERPAPI_API_KEY"];
		await expect(serpApiSearch("test")).rejects.toThrow(/SerpApi key required/);
	});

	it("GETs serpapi.com/search.json with engine/q/api_key/num params", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			capturedUrl = url;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ organic_results: [] }),
			};
		}) as typeof fetch;

		try {
			await serpApiSearch("coffee", { apiKey: "test-key", numResults: 7 });
		} finally {
			globalThis.fetch = originalFetch;
		}

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://serpapi.com/search.json");
		expect(url.searchParams.get("engine")).toBe("google");
		expect(url.searchParams.get("q")).toBe("coffee");
		expect(url.searchParams.get("api_key")).toBe("test-key");
		expect(url.searchParams.get("num")).toBe("7");
	});

	it("maps organic_results[] to WebSearchResult[]", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({
				organic_results: [{ title: "A", link: "https://a.example", snippet: "snippet a" }],
			}),
		}) as unknown as typeof fetch;

		try {
			const results = await serpApiSearch("test", { apiKey: "key" });
			expect(results).toEqual([{ url: "https://a.example", title: "A", snippet: "snippet a" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws when the response is 200 but carries a top-level error field", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ error: "Your account has run out of searches." }),
		}) as unknown as typeof fetch;

		try {
			await expect(serpApiSearch("test", { apiKey: "key" })).rejects.toThrow(/Your account has run out of searches/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws a descriptive error on a non-2xx response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }) as unknown as typeof fetch;
		try {
			await expect(serpApiSearch("test", { apiKey: "key" })).rejects.toThrow(/SerpApi error: 401/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("SerpApiSearchEngine — port conformance", () => {
	it("implements ISearchEngine", () => {
		const engine: ISearchEngine = new SerpApiSearchEngine("key");
		expect(typeof engine.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// RoundRobinSearchEngine — per-engine cooldown
// ---------------------------------------------------------------------------

describe("RoundRobinSearchEngine — per-engine cooldown", () => {
	it("skips a cooling-down engine's rotation slot in favor of the next available one", async () => {
		let now = 0;
		const a = failEngine("engine a: Tavily API error: 432");
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b], { cooldownMs: 60_000, now: () => now });

		await expect(engine.search(REQ)).rejects.toThrow(); // a fails, cools down; no fallback within round-robin itself
		now += 1_000;
		// cursor now points at b regardless; advance one more full cycle to reach a's slot again
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_B]); // b's turn
		await expect(engine.search(REQ)).resolves.toEqual([RESULT_B]); // a's turn, but a is cooling down -- skips to b
		expect(a.search).toHaveBeenCalledTimes(1);
		expect(b.search).toHaveBeenCalledTimes(2);
	});

	it("throws when every engine is currently in cooldown", async () => {
		let now = 0;
		const a = failEngine("Tavily API error: 432");
		const b = failEngine("SerpApi error: 429");
		const engine = new RoundRobinSearchEngine([a, b], { cooldownMs: 60_000, now: () => now });

		await expect(engine.search(REQ)).rejects.toThrow(); // a fails, cools down
		await expect(engine.search(REQ)).rejects.toThrow(); // b fails, cools down
		now += 1_000;
		await expect(engine.search(REQ)).rejects.toThrow(/every engine is currently in cooldown/);
		expect(a.search).toHaveBeenCalledTimes(1);
		expect(b.search).toHaveBeenCalledTimes(1);
	});

	it("reports a cooldown skip via onEngineFailure with the real engine index, not the call that eventually succeeds", async () => {
		let now = 0;
		const calls: Array<{ index: number; reason: string }> = [];
		const a = failEngine("Tavily API error: 432");
		const b = okEngine([RESULT_B]);
		const engine = new RoundRobinSearchEngine([a, b], {
			cooldownMs: 60_000,
			now: () => now,
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await expect(engine.search(REQ)).rejects.toThrow(); // index 0 fails
		await engine.search(REQ); // index 1 succeeds
		await engine.search(REQ); // index 0's turn, but cooling down -- skip to index 1

		expect(calls).toEqual([{ index: 0, reason: "error" }, { index: 0, reason: "cooldown" }]);
	});
});

// ---------------------------------------------------------------------------
// defaultSearchEngine — round-robin wiring across keyed providers
// ---------------------------------------------------------------------------

describe("defaultSearchEngine — round-robin wiring", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	function clearAllProviderKeys(): void {
		for (const key of ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY"]) {
			delete process.env[key];
		}
	}

	it("auto-skips serper/serpapi when their env vars are unset -- never throws by itself", () => {
		clearAllProviderKeys();
		process.env["TAVILY_API_KEY"] = "fake-key";
		expect(() => defaultSearchEngine()).not.toThrow();
	});

	it("with zero keyed providers configured, still resolves to DDG only", async () => {
		clearAllProviderKeys();
		const engine = defaultSearchEngine();
		// Real DDG call would hit the network; just prove construction succeeded
		// and didn't throw building an empty RoundRobinSearchEngine.
		expect(typeof engine.search).toBe("function");
	});

	it("round-robins across every configured keyed provider (spreads calls instead of always hitting the same one)", async () => {
		clearAllProviderKeys();
		process.env["TAVILY_API_KEY"] = "tavily-key";
		process.env["SERPER_API_KEY"] = "serper-key";
		process.env["SERPAPI_API_KEY"] = "serpapi-key";

		const originalFetch = globalThis.fetch;
		const calledHosts: string[] = [];
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			calledHosts.push(new URL(url).host);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ results: [{ url: "https://a.example", title: "A" }], organic: [{ title: "A", link: "https://a.example" }], organic_results: [{ title: "A", link: "https://a.example" }] }),
			};
		}) as typeof fetch;

		try {
			const engine = defaultSearchEngine();
			await engine.search({ query: "q1" });
			await engine.search({ query: "q2" });
			await engine.search({ query: "q3" });
		} finally {
			globalThis.fetch = originalFetch;
		}

		// Three configured providers, three calls -- each provider's host should
		// appear exactly once if round-robin is actually spreading load.
		expect(new Set(calledHosts).size).toBe(3);
	});

	it("does not wrap a single configured engine in a round-robin group -- behaves exactly as the ungrouped single-engine path", async () => {
		clearAllProviderKeys();
		process.env["TAVILY_API_KEY"] = "tavily-key";

		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			callCount++;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ results: [{ url: "https://a.example", title: "A" }] }),
			};
		}) as typeof fetch;

		try {
			const engine = defaultSearchEngine();
			await engine.search({ query: "q1" });
			await engine.search({ query: "q2" });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(callCount).toBe(2); // every call reaches the one configured engine, nothing skipped
	});

	it("the outer chain's own cooldown is disabled when a rotation group exists -- one member's rate-limit failure never cools down healthy peers", async () => {
		clearAllProviderKeys();
		process.env["TAVILY_API_KEY"] = "tavily-key";
		process.env["SERPER_API_KEY"] = "serper-key";

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			// Tavily always 432s; Serper always succeeds.
			if (new URL(url).host.includes("tavily")) {
				return { ok: false, status: 432, statusText: "Usage Limit Exceeded" };
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ organic: [{ title: "A", link: "https://a.example" }] }),
			};
		}) as typeof fetch;

		try {
			const engine = defaultSearchEngine();
			// Whichever provider is picked first, the chain must still resolve
			// with real results -- not throw, and not skip Serper due to an
			// outer-level cooldown mistakenly applied to the whole group.
			const first = await engine.search({ query: "q1" });
			const second = await engine.search({ query: "q2" });
			expect(first.length + second.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
