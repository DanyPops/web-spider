/**
 * Unit tests for the web-search strategy layer.
 *
 * No network calls — every ISearchEngine is stubbed so these run offline
 * and exercise the FallbackSearchEngine composition logic in isolation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import { BraveSearchEngine, CapabilityRoutedSearchEngine, ExaSearchEngine, FallbackSearchEngine, InMemorySiteAvailabilityTracker, RoundRobinSearchEngine, SerpApiSearchEngine, SerperSearchEngine, SiteRoutedSearchEngine, TavilySearchEngine, YouComSearchEngine, braveSearch, defaultAnswerEngine, defaultSearchEngine, envKeyForEngine, exaSearch, isLikelyQuotaExceededError, isLikelyRateLimitError, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine, serpApiSearch, serperSearch, tavilySearch, tavilySearchForAnswer, webSearch, youComSearch } from "../src/web-search.js";
import type { NamedSearchEngine } from "../src/web-search.js";

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
// Recommended composition: Tavily → a second-choice engine
// ---------------------------------------------------------------------------

describe("Tavily + fallback-engine pattern", () => {
	it("returns Tavily results when Tavily succeeds", async () => {
		const tavily = okEngine([RESULT_A]);
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_A]);
		expect(secondary.search).not.toHaveBeenCalled();
	});

	it("falls back to the next engine when Tavily returns empty", async () => {
		const tavily = okEngine([]);
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_B]);
	});

	it("falls back to the next engine when Tavily throws (e.g. rate limit)", async () => {
		const tavily = failEngine("429 rate limit");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary]);

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_B]);
	});

	it("returns empty when both engines find nothing", async () => {
		const engine = new FallbackSearchEngine([okEngine([]), okEngine([])]);
		const results = await engine.search(REQ);
		expect(results).toEqual([]);
	});

	it("returns empty (not Tavily's stale error) when Tavily throws and the next engine then succeeds with zero hits", async () => {
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([]);
		const engine = new FallbackSearchEngine([tavily, secondary]);

		await expect(engine.search(REQ)).resolves.toEqual([]);
	});
});

describe("FallbackSearchEngine — rate-limit cooldown", () => {
	it("skips an engine on the next call after a rate-limit-shaped failure, within the cooldown window", async () => {
		let now = 0;
		const tavily = failEngine("429 rate limit");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1);

		now += 1_000; // still within the cooldown window
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1); // not called again -- skipped
		expect(secondary.search).toHaveBeenCalledTimes(2);
	});

	it("retries the engine again once the cooldown window elapses", async () => {
		let now = 0;
		const tavily = failEngine("429 rate limit");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		now += 60_001;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("does not cool down on a non-rate-limit error -- retries every call", async () => {
		let now = 0;
		const tavily = failEngine("highlights format requires a query");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { cooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("cooldownMs: 0 disables cooldown entirely", async () => {
		let now = 0;
		const tavily = failEngine("429 rate limit");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { cooldownMs: 0, now: () => now });

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("a custom isRateLimitError predicate overrides the default heuristic", async () => {
		let now = 0;
		const tavily = failEngine("weird provider-specific overload code");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], {
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

describe("FallbackSearchEngine — quota cooldown (separate, longer tier from rate-limit cooldown)", () => {
	it("applies the longer quotaCooldownMs, not cooldownMs, for a quota-shaped failure", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([RESULT_B]);
		// cooldownMs (rate-limit tier) would have expired by now += 60_001; quotaCooldownMs must not have.
		const engine = new FallbackSearchEngine([tavily, secondary], { cooldownMs: 60_000, quotaCooldownMs: 6 * 60 * 60_000, now: () => now });

		await engine.search(REQ);
		now += 61_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1); // still skipped -- the rate-limit window doesn't apply here
	});

	it("retries once the quota cooldown window elapses", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { quotaCooldownMs: 60_000, now: () => now });

		await engine.search(REQ);
		now += 60_001;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2);
	});

	it("quotaCooldownMs: 0 disables the quota tier -- falls through to rate-limit classification instead", async () => {
		let now = 0;
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], { quotaCooldownMs: 0, now: () => now });

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(2); // no cooldown applied at all -- 432 no longer matches isLikelyRateLimitError either
	});

	it("a custom isQuotaError predicate overrides the default heuristic", async () => {
		let now = 0;
		const tavily = failEngine("weird provider-specific plan-exhausted code");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], {
			quotaCooldownMs: 60_000,
			now: () => now,
			isQuotaError: (err) => err instanceof Error && err.message.includes("plan-exhausted"),
		});

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(tavily.search).toHaveBeenCalledTimes(1); // skipped on the 2nd call
	});
});

describe("FallbackSearchEngine — onEngineFailure", () => {
	it("reports an engine's own index, error, and reason:\"error\" for a non-quota failure", async () => {
		const calls: Array<{ index: number; reason: string }> = [];
		const tavily = failEngine("429 rate limit");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], {
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await engine.search(REQ);
		expect(calls).toEqual([{ index: 0, reason: "error" }]);
	});

	it("reports reason:\"quota\" for a quota-exhaustion-shaped failure", async () => {
		const calls: Array<{ index: number; reason: string }> = [];
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], {
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await engine.search(REQ);
		expect(calls).toEqual([{ index: 0, reason: "quota" }]);
	});

	it("reports reason:\"cooldown\" for an engine skipped without ever being called", async () => {
		let now = 0;
		const calls: Array<{ index: number; reason: string }> = [];
		const tavily = failEngine("Tavily API error: 432");
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([tavily, secondary], {
			quotaCooldownMs: 60_000,
			now: () => now,
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await engine.search(REQ);
		now += 1_000;
		await engine.search(REQ);
		expect(calls).toEqual([{ index: 0, reason: "quota" }, { index: 0, reason: "cooldown" }]);
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
		const secondary = okEngine([RESULT_B]);
		const engine = new FallbackSearchEngine([new RoundRobinSearchEngine([a, b]), secondary]);

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

// ---------------------------------------------------------------------------
// onUsage -- per-call usage/cost reporting (Tavily credits, Exa costDollars,
// Brave rate-limit-shaped headers when present)
// ---------------------------------------------------------------------------

describe("tavilySearch onUsage", () => {
	it("requests include_usage and reports credits from the response", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> | null = null;
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string ?? "{}");
			return {
				ok: true, status: 200, statusText: "OK",
				headers: { get: () => "application/json" },
				json: async () => ({ results: [], usage: { credits: 3 } }),
			};
		}) as typeof fetch;

		try {
			const usages: unknown[] = [];
			await tavilySearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(capturedBody).toMatchObject({ include_usage: true });
			expect(usages).toEqual([{ credits: 3 }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not call onUsage when the response carries no usage field", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [] }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			await tavilySearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(usages).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("exaSearch onUsage", () => {
	it("reports costDollars.total from the response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [], costDollars: { total: 0.006, search: { neural: 0.006 } } }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			await exaSearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(usages).toEqual([{ costUsd: 0.006 }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not call onUsage when costDollars is absent (Exa only includes non-zero costs)", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [] }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			await exaSearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(usages).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("braveSearch onUsage", () => {
	it("reports only headers whose name looks rate-limit/quota-shaped, never a blanket header capture", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: new Headers({
				"content-type": "application/json",
				"x-ratelimit-remaining": "42",
				"x-ratelimit-limit": "2000",
			}),
			json: async () => ({ web: { results: [] } }),
		}) as unknown as typeof fetch;
		try {
			const usages: Array<{ rateLimitHeaders?: Record<string, string> }> = [];
			await braveSearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(usages).toHaveLength(1);
			expect(usages[0]?.rateLimitHeaders).toEqual({ "x-ratelimit-remaining": "42", "x-ratelimit-limit": "2000" });
			expect(usages[0]?.rateLimitHeaders).not.toHaveProperty("content-type");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not call onUsage when no response header looks rate-limit-shaped (the real, currently-unconfirmed case)", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ web: { results: [] } }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			await braveSearch("q", { apiKey: "key", onUsage: (u) => usages.push(u) });
			expect(usages).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("*SearchEngine classes forward onUsage", () => {
	it("TavilySearchEngine forwards onUsage into tavilySearch", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [], usage: { credits: 1 } }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			const engine = new TavilySearchEngine("key", (u) => usages.push(u));
			await engine.search(REQ);
			expect(usages).toEqual([{ credits: 1 }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("ExaSearchEngine forwards onUsage into exaSearch", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [], costDollars: { total: 0.01 } }),
		}) as unknown as typeof fetch;
		try {
			const usages: unknown[] = [];
			const engine = new ExaSearchEngine("key", (u) => usages.push(u));
			await engine.search(REQ);
			expect(usages).toEqual([{ costUsd: 0.01 }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("BraveSearchEngine forwards onUsage into braveSearch", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: new Headers({ "x-ratelimit-remaining": "5" }),
			json: async () => ({ web: { results: [] } }),
		}) as unknown as typeof fetch;
		try {
			const usages: Array<{ rateLimitHeaders?: Record<string, string> }> = [];
			const engine = new BraveSearchEngine("key", undefined, (u) => usages.push(u));
			await engine.search(REQ);
			expect(usages[0]?.rateLimitHeaders).toEqual({ "x-ratelimit-remaining": "5" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("defaultSearchEngine onUsage attribution", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("reports usage tagged with the real engine name (tavily), not a generic label", async () => {
		process.env["TAVILY_API_KEY"] = "fake-key";
		for (const key of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY"]) delete process.env[key];

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			headers: { get: () => "application/json" },
			json: async () => ({ results: [{ url: "https://a.example", title: "A" }], usage: { credits: 2 } }),
		}) as unknown as typeof fetch;

		const calls: Array<{ name: string; usage: unknown }> = [];
		try {
			const engine = defaultSearchEngine({ onUsage: (name, usage) => calls.push({ name, usage }) });
			await engine.search({ query: "q" });
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(calls).toEqual([{ name: "tavily", usage: { credits: 2 } }]);
	});
});

describe("isLikelyRateLimitError", () => {
	it("treats a standard 429 message as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("Brave Search API error: 429 Too Many Requests"))).toBe(true);
	});

	it("treats rate-limit-shaped message text as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("rate limit exceeded, try again later"))).toBe(true);
		expect(isLikelyRateLimitError(new Error("too many requests, slow down"))).toBe(true);
	});

	it("does not treat Tavily's non-standard 432 as a rate limit -- that's quota exhaustion, not throttling", () => {
		expect(isLikelyRateLimitError(new Error("Tavily API error: 432"))).toBe(false);
	});

	it("does not treat quota-shaped message text as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("quota exceeded for this API key"))).toBe(false);
	});

	it("does not treat a genuine domain-level error as a rate limit", () => {
		expect(isLikelyRateLimitError(new Error("highlights format requires a query"))).toBe(false);
	});

	it("does not treat a non-Error value as a rate limit", () => {
		expect(isLikelyRateLimitError("432")).toBe(false);
	});
});

describe("isLikelyQuotaExceededError", () => {
	it("treats Tavily's non-standard 432 as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError(new Error("Tavily API error: 432"))).toBe(true);
	});

	it("treats 402 Payment Required as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError(new Error("SerpApi error: 402 Payment Required"))).toBe(true);
	});

	it("treats quota/plan/credits-shaped message text as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError(new Error("quota exceeded for this API key"))).toBe(true);
		expect(isLikelyQuotaExceededError(new Error("Your account has run out of searches."))).toBe(true);
		expect(isLikelyQuotaExceededError(new Error("insufficient credits to complete this request"))).toBe(true);
		expect(isLikelyQuotaExceededError(new Error("monthly plan limit reached"))).toBe(true);
	});

	it("does not treat a plain 429 rate limit as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError(new Error("Brave Search API error: 429 Too Many Requests"))).toBe(false);
	});

	it("does not treat a genuine domain-level error as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError(new Error("highlights format requires a query"))).toBe(false);
	});

	it("does not treat a non-Error value as quota exhaustion", () => {
		expect(isLikelyQuotaExceededError("432")).toBe(false);
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

		// Every provider is unreachable here (fetch always 432s), so the chain
		// as a whole still rejects; only the first (Tavily) entry matters for this assertion.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("rate limited", { status: 432, statusText: "Usage Limit Exceeded" })) as typeof fetch;
		try {
			await expect(engine.search({ query: "test" })).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(calls[0]).toEqual({ name: "tavily", reason: "quota" });
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
			quotaCooldownMs: 60_000,
			now: () => now,
			onEngineFailure: (index, _error, reason) => { calls.push({ index, reason }); },
		});

		await expect(engine.search(REQ)).rejects.toThrow(); // index 0 fails
		await engine.search(REQ); // index 1 succeeds
		await engine.search(REQ); // index 0's turn, but cooling down -- skip to index 1

		expect(calls).toEqual([{ index: 0, reason: "quota" }, { index: 0, reason: "cooldown" }]);
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

	it("with zero keyed providers configured, throws a clear no-engine-configured error", () => {
		clearAllProviderKeys();
		expect(() => defaultSearchEngine()).toThrow(/no search engine api key configured/i);
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

	it("defaultSearchEngine returns the round-robin group directly -- one member's failure never cools down a healthy peer", async () => {
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
			expect(engine).toBeInstanceOf(SiteRoutedSearchEngine); // SiteRoutedSearchEngine wraps the round-robin group, not an outer FallbackSearchEngine
			// Tavily is checked before Serper, so the round-robin's first turn
			// always lands on it -- that call legitimately throws (no keyless
			// fallback exists to mask a real failure anymore). The point of this
			// test is the *second* call: the round-robin's own per-engine cooldown
			// routes it to the healthy Serper peer instead of also failing.
			await expect(engine.search({ query: "q1" })).rejects.toThrow();
			const second = await engine.search({ query: "q2" });
			expect(second.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// youComSearch / YouComSearchEngine
// ---------------------------------------------------------------------------

describe("youComSearch", () => {
	it("throws when no API key is provided and env var is absent", async () => {
		delete process.env["YOU_API_KEY"];
		await expect(youComSearch("test")).rejects.toThrow(/YOU_API_KEY/);
	});

	it("GETs api.ydc-index.io/v1/search with X-API-Key header", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedHeaders = init?.headers as Record<string, string>;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ results: { web: [] } }),
			};
		}) as typeof fetch;

		try {
			await youComSearch("coffee", { apiKey: "test-key", numResults: 5 });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(capturedUrl).toContain("https://api.ydc-index.io/v1/search?");
		expect(capturedUrl).toContain("query=coffee");
		expect(capturedUrl).toContain("count=5");
		expect(capturedHeaders["X-API-Key"]).toBe("test-key");
	});

	it("maps results.web[] to WebSearchResult[], including multiple snippets as highlights", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				results: {
					web: [
						{
							url: "https://a.example",
							title: "A",
							description: "desc a",
							snippets: ["first passage", "second passage"],
							page_age: "2025-01-01",
						},
					],
				},
			}),
		}) as unknown as typeof fetch;

		try {
			const results = await youComSearch("test", { apiKey: "key" });
			expect(results).toEqual([
				{ url: "https://a.example", title: "A", snippet: "desc a", publishedAt: "2025-01-01", highlights: ["first passage", "second passage"] },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("falls back to the first snippet when description is absent", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: { web: [{ url: "https://a.example", title: "A", snippets: ["only this"] }] } }),
		}) as unknown as typeof fetch;
		try {
			const results = await youComSearch("test", { apiKey: "key" });
			expect(results[0]?.snippet).toBe("only this");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("sends siteFilter as include_domains", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			capturedUrl = url;
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: { web: [] } }) };
		}) as typeof fetch;
		try {
			await youComSearch("test", { apiKey: "key", siteFilter: "reddit.com" });
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(capturedUrl).toContain("include_domains=reddit.com");
	});

	it("throws a descriptive error on a non-2xx response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }) as unknown as typeof fetch;
		try {
			await expect(youComSearch("test", { apiKey: "key" })).rejects.toThrow(/You\.com API error: 401/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("YouComSearchEngine — port conformance", () => {
	it("implements ISearchEngine", () => {
		const engine: ISearchEngine = new YouComSearchEngine("key");
		expect(typeof engine.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// exaSearch — highlights field
// ---------------------------------------------------------------------------

describe("exaSearch — highlights field", () => {
	it("populates WebSearchResult.highlights from Exa's highlights array", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [{ url: "https://a.example", title: "A", highlights: ["h1", "h2"] }] }),
		}) as unknown as typeof fetch;
		try {
			const results = await exaSearch("test", { apiKey: "key" });
			expect(results[0]?.highlights).toEqual(["h1", "h2"]);
			expect(results[0]?.snippet).toBe("h1 … h2");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("omits highlights when Exa returns none", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [{ url: "https://a.example", title: "A" }] }),
		}) as unknown as typeof fetch;
		try {
			const results = await exaSearch("test", { apiKey: "key" });
			expect(results[0]).not.toHaveProperty("highlights");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("sends siteFilter as includeDomains", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) };
		}) as typeof fetch;
		try {
			await exaSearch("test", { apiKey: "key", siteFilter: "reddit.com" });
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(capturedBody["includeDomains"]).toEqual(["reddit.com"]);
	});

	it("includeText requests contents.text and populates WebSearchResult.content; omitted by default", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [{ url: "https://a.example", title: "A", text: "full page text" }] }) };
		}) as typeof fetch;
		try {
			const results = await exaSearch("test", { apiKey: "key", includeText: true });
			expect((capturedBody["contents"] as Record<string, unknown>)["text"]).toBe(true);
			expect(results[0]?.content).toBe("full page text");
		} finally {
			globalThis.fetch = originalFetch;
		}

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [{ url: "https://a.example", title: "A" }] }), // Exa omits `text` entirely when contents.text wasn't requested
		}) as unknown as typeof fetch;
		try {
			const results = await exaSearch("test", { apiKey: "key" });
			expect(results[0]).not.toHaveProperty("content");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// braveSearch — extra_snippets field
// ---------------------------------------------------------------------------

describe("braveSearch — extra_snippets field", () => {
	it("extraSnippets:true sets extra_snippets=true and populates WebSearchResult.highlights", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			capturedUrl = url;
			return {
				ok: true, status: 200, statusText: "OK", headers: new Headers(),
				json: async () => ({ web: { results: [{ url: "https://a.example", title: "A", description: "d", extra_snippets: ["e1", "e2"] }] } }),
			};
		}) as typeof fetch;
		try {
			const results = await braveSearch("test", { apiKey: "key", extraSnippets: true });
			expect(capturedUrl).toContain("extra_snippets=true");
			expect(results[0]?.highlights).toEqual(["e1", "e2"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("omits extra_snippets param and highlights field when not requested", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			capturedUrl = url;
			return {
				ok: true, status: 200, statusText: "OK", headers: new Headers(),
				json: async () => ({ web: { results: [{ url: "https://a.example", title: "A", description: "d" }] } }),
			};
		}) as typeof fetch;
		try {
			const results = await braveSearch("test", { apiKey: "key" });
			expect(capturedUrl).not.toContain("extra_snippets");
			expect(results[0]).not.toHaveProperty("highlights");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("BraveSearchEngine requests extra_snippets by default (no vendor cost per Brave's own docs)", async () => {
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			capturedUrl = url;
			return { ok: true, status: 200, statusText: "OK", headers: new Headers(), json: async () => ({ web: { results: [] } }) };
		}) as typeof fetch;
		try {
			const engine = new BraveSearchEngine("key");
			await engine.search(REQ);
			expect(capturedUrl).toContain("extra_snippets=true");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// tavilySearch — content field, siteFilter; tavilySearchForAnswer
// ---------------------------------------------------------------------------

describe("tavilySearch — content field and siteFilter", () => {
	it("does not request raw content by default", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) };
		}) as typeof fetch;
		try {
			await tavilySearch("test", { apiKey: "key" });
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(capturedBody["include_raw_content"]).toBe(false);
	});

	it("populates WebSearchResult.content when includeRawContent is set and Tavily returns raw_content", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [{ url: "https://a.example", title: "A", content: "snippet", raw_content: "full page text" }] }),
		}) as unknown as typeof fetch;
		try {
			const results = await tavilySearch("test", { apiKey: "key", includeRawContent: true });
			expect(results[0]?.content).toBe("full page text");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("sends siteFilter as include_domains", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) };
		}) as typeof fetch;
		try {
			await tavilySearch("test", { apiKey: "key", siteFilter: "reddit.com" });
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(capturedBody["include_domains"]).toEqual(["reddit.com"]);
	});
});

describe("tavilySearchForAnswer", () => {
	it("requests include_answer and returns { answer, sources }", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return {
				ok: true, status: 200, statusText: "OK",
				json: async () => ({
					answer: "The answer is 42.",
					results: [{ url: "https://a.example", title: "A", content: "snippet" }],
				}),
			};
		}) as typeof fetch;

		try {
			const result = await tavilySearchForAnswer("test", { apiKey: "key" });
			expect(capturedBody["include_answer"]).toBe(true);
			expect(result).toEqual({
				answer: "The answer is 42.",
				sources: [{ url: "https://a.example", title: "A", snippet: "snippet" }],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns an empty answer string (not a throw) when Tavily reports none", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [] }),
		}) as unknown as typeof fetch;
		try {
			const result = await tavilySearchForAnswer("test", { apiKey: "key" });
			expect(result).toEqual({ answer: "", sources: [] });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws when no API key is provided and env var is absent", async () => {
		delete process.env["TAVILY_API_KEY"];
		await expect(tavilySearchForAnswer("test")).rejects.toThrow(/Tavily API key required/);
	});
});

describe("TavilySearchEngine.searchForAnswer", () => {
	it("implements IAnswerSearchEngine and delegates to tavilySearchForAnswer", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ answer: "42", results: [] }),
		}) as unknown as typeof fetch;
		try {
			const engine = new TavilySearchEngine("key");
			const result = await engine.searchForAnswer(REQ);
			expect(result).toEqual({ answer: "42", sources: [] });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// InMemorySiteAvailabilityTracker
// ---------------------------------------------------------------------------

describe("InMemorySiteAvailabilityTracker", () => {
	it("returns engine names unmodified for a site with no recorded history", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		expect(tracker.order("reddit.com", ["brave", "tavily", "serper"])).toEqual(["brave", "tavily", "serper"]);
	});

	it("puts an engine with a recorded match first, ahead of untested engines", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		tracker.recordAttempt("reddit.com", "serper", true);
		expect(tracker.order("reddit.com", ["brave", "tavily", "serper"])).toEqual(["serper", "brave", "tavily"]);
	});

	it("puts a currently-blocked engine last, behind untested engines", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		tracker.recordAttempt("reddit.com", "tavily", false);
		expect(tracker.order("reddit.com", ["brave", "tavily", "serper"])).toEqual(["brave", "serper", "tavily"]);
	});

	it("expires a blocked verdict after blockedTtlMs, making the engine untested again", () => {
		let now = 0;
		const tracker = new InMemorySiteAvailabilityTracker({ blockedTtlMs: 1000, now: () => now });
		tracker.recordAttempt("reddit.com", "tavily", false);
		expect(tracker.order("reddit.com", ["tavily", "brave"])).toEqual(["brave", "tavily"]);
		now = 1001;
		expect(tracker.order("reddit.com", ["tavily", "brave"])).toEqual(["tavily", "brave"]);
	});

	it("a later success clears a previous blocked verdict for that engine", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		tracker.recordAttempt("reddit.com", "tavily", false);
		tracker.recordAttempt("reddit.com", "tavily", true);
		expect(tracker.order("reddit.com", ["brave", "tavily"])).toEqual(["tavily", "brave"]);
	});

	it("tracks sites independently -- a verdict for one site never affects another", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		tracker.recordAttempt("reddit.com", "tavily", false);
		expect(tracker.order("wikipedia.org", ["tavily", "brave"])).toEqual(["tavily", "brave"]);
	});

	it("evicts the oldest-touched site once maxSites is exceeded", () => {
		const tracker = new InMemorySiteAvailabilityTracker({ maxSites: 2 });
		tracker.recordAttempt("site-a.com", "brave", true);
		tracker.recordAttempt("site-b.com", "brave", true);
		tracker.recordAttempt("site-c.com", "brave", true); // evicts site-a.com (oldest)
		expect(tracker.order("site-a.com", ["brave", "tavily"])).toEqual(["brave", "tavily"]); // forgotten -- back to unmodified order
		expect(tracker.order("site-c.com", ["tavily", "brave"])).toEqual(["brave", "tavily"]); // remembered
	});

	it("site lookups are case-insensitive", () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		tracker.recordAttempt("Reddit.COM", "serper", true);
		expect(tracker.order("reddit.com", ["brave", "serper"])).toEqual(["serper", "brave"]);
	});
});

// ---------------------------------------------------------------------------
// SiteRoutedSearchEngine
// ---------------------------------------------------------------------------

describe("SiteRoutedSearchEngine", () => {
	function named(name: string, engine: ISearchEngine): NamedSearchEngine {
		return { name, engine };
	}

	it("delegates straight to the plain engine, untouched, when the query has no site filter", async () => {
		const plain = okEngine([RESULT_A]);
		const routed = new SiteRoutedSearchEngine([named("a", okEngine([RESULT_B]))], plain);
		const results = await routed.search(REQ);
		expect(results).toEqual([RESULT_A]);
		expect(plain.search).toHaveBeenCalledTimes(1);
	});

	it("filters an engine's results down to ones actually matching the requested site", async () => {
		const mixedResults = [RESULT_A, { url: "https://reddit.com/r/x", title: "R", snippet: "s" }];
		const engineA = okEngine(mixedResults);
		const routed = new SiteRoutedSearchEngine([named("a", engineA)], okEngine([]));
		const results = await routed.search({ query: "q", siteFilter: "reddit.com" });
		expect(results).toEqual([{ url: "https://reddit.com/r/x", title: "R", snippet: "s" }]);
	});

	it("matches a subdomain of the requested site", async () => {
		const engineA = okEngine([{ url: "https://old.reddit.com/r/x", title: "R", snippet: "s" }]);
		const routed = new SiteRoutedSearchEngine([named("a", engineA)], okEngine([]));
		const results = await routed.search({ query: "q", siteFilter: "reddit.com" });
		expect(results).toHaveLength(1);
	});

	it("tries the next named engine when the first returns zero on-domain matches", async () => {
		const engineA = okEngine([RESULT_A]); // off-domain -- filtered to empty
		const engineB = okEngine([{ url: "https://reddit.com/r/x", title: "R", snippet: "s" }]);
		const routed = new SiteRoutedSearchEngine([named("a", engineA), named("b", engineB)], okEngine([]));
		const results = await routed.search({ query: "q", siteFilter: "reddit.com" });
		expect(results).toHaveLength(1);
		expect(engineA.search).toHaveBeenCalledTimes(1);
		expect(engineB.search).toHaveBeenCalledTimes(1);
	});

	it("returns empty (not a throw) when every named engine has zero on-domain matches", async () => {
		const routed = new SiteRoutedSearchEngine(
			[named("a", okEngine([RESULT_A])), named("b", okEngine([RESULT_B]))],
			okEngine([]),
		);
		await expect(routed.search({ query: "q", siteFilter: "reddit.com" })).resolves.toEqual([]);
	});

	it("throws the last error when every named engine fails and none ever matched", async () => {
		const routed = new SiteRoutedSearchEngine(
			[named("a", failEngine("a down")), named("b", failEngine("b down"))],
			okEngine([]),
		);
		await expect(routed.search({ query: "q", siteFilter: "reddit.com" })).rejects.toThrow("b down");
	});

	it("detects a literal site: operator in the raw query text, without an explicit siteFilter", async () => {
		const engineA = okEngine([{ url: "https://reddit.com/r/x", title: "R", snippet: "s" }]);
		const routed = new SiteRoutedSearchEngine([named("a", engineA)], okEngine([]));
		const results = await routed.search({ query: "best pizza site:reddit.com" });
		expect(results).toHaveLength(1);
	});

	it("records every attempt in the tracker and reorders subsequent calls for the same site", async () => {
		const tracker = new InMemorySiteAvailabilityTracker();
		const engineA = okEngine([RESULT_A]); // off-domain -- always filtered to empty for reddit.com
		const engineB = okEngine([{ url: "https://reddit.com/r/x", title: "R", snippet: "s" }]);
		const routed = new SiteRoutedSearchEngine([named("a", engineA), named("b", engineB)], okEngine([]), { tracker });

		await routed.search({ query: "q1", siteFilter: "reddit.com" });
		expect(engineA.search).toHaveBeenCalledTimes(1);
		expect(engineB.search).toHaveBeenCalledTimes(1);

		// Second call: tracker now orders b (known-working) before a -- b alone should suffice.
		vi.mocked(engineA.search).mockClear();
		vi.mocked(engineB.search).mockClear();
		await routed.search({ query: "q2", siteFilter: "reddit.com" });
		expect(engineB.search).toHaveBeenCalledTimes(1);
		expect(engineA.search).not.toHaveBeenCalled();
	});

	it("throws when constructed with an empty engines array", () => {
		expect(() => new SiteRoutedSearchEngine([], okEngine([]))).toThrow("at least one engine");
	});

	it("implements ISearchEngine — assignable to the port type", () => {
		const engine: ISearchEngine = new SiteRoutedSearchEngine([named("a", okEngine([]))], okEngine([]));
		expect(typeof engine.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// CapabilityRoutedSearchEngine — declarative wantFullContent routing
// ---------------------------------------------------------------------------

describe("CapabilityRoutedSearchEngine", () => {
	function named(name: string, engine: ISearchEngine, supportsFullContent = false): NamedSearchEngine {
		return { name, engine, supportsFullContent };
	}

	it("delegates straight to plain, untouched, when wantFullContent isn't set", async () => {
		const plain = okEngine([RESULT_A]);
		const capable = okEngine([RESULT_B]);
		const routed = new CapabilityRoutedSearchEngine([named("tavily", capable, true)], plain);
		const results = await routed.search(REQ);
		expect(results).toEqual([RESULT_A]);
		expect(capable.search).not.toHaveBeenCalled();
	});

	it("tries a content-capable engine first when wantFullContent is set, never touching plain", async () => {
		const plain = okEngine([RESULT_A]);
		const capable = okEngine([{ ...RESULT_B, content: "full text" }]);
		const routed = new CapabilityRoutedSearchEngine([named("brave", okEngine([RESULT_A]), false), named("tavily", capable, true)], plain);
		const results = await routed.search({ ...REQ, wantFullContent: true });
		expect(results).toEqual([{ ...RESULT_B, content: "full text" }]);
		expect(plain.search).not.toHaveBeenCalled();
	});

	it("falls through to plain when no engine declares content support", async () => {
		const plain = okEngine([RESULT_A]);
		const routed = new CapabilityRoutedSearchEngine([named("brave", okEngine([RESULT_B]), false)], plain);
		const results = await routed.search({ ...REQ, wantFullContent: true });
		expect(results).toEqual([RESULT_A]);
	});

	it("falls through to plain when every content-capable engine fails", async () => {
		const plain = okEngine([RESULT_A]);
		const routed = new CapabilityRoutedSearchEngine([named("tavily", failEngine("tavily down"), true)], plain);
		const results = await routed.search({ ...REQ, wantFullContent: true });
		expect(results).toEqual([RESULT_A]);
	});

	it("throws when constructed with an empty engines array", () => {
		expect(() => new CapabilityRoutedSearchEngine([], okEngine([]))).toThrow("at least one engine");
	});

	it("implements ISearchEngine — assignable to the port type", () => {
		const engine: ISearchEngine = new CapabilityRoutedSearchEngine([named("tavily", okEngine([]), true)], okEngine([]));
		expect(typeof engine.search).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// defaultAnswerEngine — capability-based resolution, not by name
// ---------------------------------------------------------------------------

describe("defaultAnswerEngine", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	for (const key of ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];

	it("throws the no-engine-configured error when zero keys are set", () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		expect(() => defaultAnswerEngine()).toThrow(/No search engine API key configured/);
	});

	it("throws a distinct error naming the configured (but answer-incapable) engines", () => {
		for (const key of ["TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["BRAVE_SEARCH_API_KEY"] = "brave-key";
		expect(() => defaultAnswerEngine()).toThrow(/brave.*don't support answer synthesis/);
	});

	it("resolves Tavily by capability when it's the only answer-capable engine configured, alongside a non-capable one", () => {
		for (const key of ["EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["BRAVE_SEARCH_API_KEY"] = "brave-key";
		process.env["TAVILY_API_KEY"] = "tavily-key";
		const engine = defaultAnswerEngine();
		expect(engine).toBeInstanceOf(TavilySearchEngine);
	});

	it("never depends on declaration order -- Tavily configured alone still resolves", () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["TAVILY_API_KEY"] = "tavily-key";
		expect(defaultAnswerEngine()).toBeInstanceOf(TavilySearchEngine);
	});
});

// ---------------------------------------------------------------------------
// webSearch — declarative wantAnswer/wantFullContent dispatch
// ---------------------------------------------------------------------------

describe("webSearch — wantAnswer/wantFullContent dispatch", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("wantAnswer:true returns an AnswerResult without the caller naming an engine", async () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["TAVILY_API_KEY"] = "tavily-key";

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ answer: "a synthesized answer", results: [] }),
		}) as unknown as typeof fetch;
		try {
			const result = await webSearch("who won", { wantAnswer: true });
			expect(result).toEqual({ answer: "a synthesized answer", sources: [] });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("wantAnswer:true with an explicitly forced non-capable engine throws a clear error", async () => {
		process.env["BRAVE_SEARCH_API_KEY"] = "brave-key";
		await expect(webSearch("who won", { wantAnswer: true, engine: "brave" })).rejects.toThrow(/does not support wantAnswer/);
	});

	it("omitting wantAnswer returns a plain WebSearchResult[]", async () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["TAVILY_API_KEY"] = "tavily-key";

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true, status: 200, statusText: "OK",
			json: async () => ({ results: [{ url: "https://a.example", title: "A", content: "c" }] }),
		}) as unknown as typeof fetch;
		try {
			const results = await webSearch("test", {});
			expect(Array.isArray(results)).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("wantFullContent forwards through to SearchQuery.wantFullContent on the plain path", async () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY", "YOU_API_KEY"]) delete process.env[key];
		process.env["TAVILY_API_KEY"] = "tavily-key";

		const originalFetch = globalThis.fetch;
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) };
		}) as typeof fetch;
		try {
			await webSearch("test", { wantFullContent: true });
			expect(capturedBody["include_raw_content"]).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// defaultSearchEngine — you.com wiring
// ---------------------------------------------------------------------------

describe("defaultSearchEngine — you.com wiring", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("includes you.com in the rotation when YOU_API_KEY is set alongside another provider", async () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY"]) delete process.env[key];
		process.env["TAVILY_API_KEY"] = "tavily-key";
		process.env["YOU_API_KEY"] = "you-key";

		const originalFetch = globalThis.fetch;
		const calledHosts: string[] = [];
		globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
			calledHosts.push(new URL(url).host);
			return {
				ok: true, status: 200, statusText: "OK",
				json: async () => ({ results: [{ url: "https://a.example", title: "A" }], web: [] }),
			};
		}) as typeof fetch;

		try {
			const engine = defaultSearchEngine();
			await engine.search({ query: "q1" });
			await engine.search({ query: "q2" });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(new Set(calledHosts).size).toBe(2); // tavily.com and api.ydc-index.io each hit once
	});

	it("resolves 'you' by name via resolveSearchEngine", () => {
		const engine = resolveSearchEngine("you", "test-you-key");
		expect(engine).toBeInstanceOf(YouComSearchEngine);
	});
});

describe("listRegisteredSearchEngines", () => {
	it("includes every built-in engine, so a consumer never needs a second hardcoded list", () => {
		const names = listRegisteredSearchEngines();
		expect(names).toEqual(expect.arrayContaining(["brave", "tavily", "exa", "serper", "serpapi", "you"]));
	});

	it("reflects a newly registered engine immediately, not a stale snapshot", () => {
		expect(listRegisteredSearchEngines()).not.toContain("listed-test-engine");
		// No unregister exists (matches ENGINE_REGISTRY's own additive-only design) -- a
		// distinctive name keeps this from ever colliding with a real engine in other tests.
		registerSearchEngine("listed-test-engine", () => okEngine([RESULT_A]));
		expect(listRegisteredSearchEngines()).toContain("listed-test-engine");
	});
});

describe("envKeyForEngine", () => {
	it("maps every built-in engine to its documented env var name", () => {
		expect(envKeyForEngine("brave")).toBe("BRAVE_SEARCH_API_KEY");
		expect(envKeyForEngine("tavily")).toBe("TAVILY_API_KEY");
		expect(envKeyForEngine("exa")).toBe("EXA_API_KEY");
		expect(envKeyForEngine("serper")).toBe("SERPER_API_KEY");
		expect(envKeyForEngine("serpapi")).toBe("SERPAPI_API_KEY");
		expect(envKeyForEngine("you")).toBe("YOU_API_KEY");
	});

	it("returns an empty string for an unknown engine name, never throws", () => {
		expect(envKeyForEngine("not-a-real-engine")).toBe("");
	});
});
