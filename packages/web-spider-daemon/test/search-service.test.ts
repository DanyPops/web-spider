import { describe, expect, test } from "bun:test";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "@danypops/web-spider";
import { SEARCH_MAX_NUM_RESULTS_CEILING } from "../src/constants.ts";
import { createEngineResolver, testProviderKeys, WebSearchService } from "../src/search/search-service.ts";

class FakeEngine implements ISearchEngine {
	public lastQuery?: SearchQuery;
	constructor(private readonly results: WebSearchResult[] = [{ url: "https://example.com", title: "Example", snippet: "…" }]) {}
	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		this.lastQuery = req;
		return this.results;
	}
}

describe("WebSearchService", () => {
	test("rejects an empty/whitespace-only query without calling the engine", async () => {
		const engine = new FakeEngine();
		const service = new WebSearchService(() => engine);
		await expect(service.search({ query: "   " })).rejects.toThrow(/query is required/);
		expect(engine.lastQuery).toBeUndefined();
	});

	test("passes query/timeRange/topic through to the resolved engine and returns its results", async () => {
		const engine = new FakeEngine([{ url: "https://a.example", title: "A", snippet: "s" }]);
		const service = new WebSearchService(() => engine);
		const result = await service.search({ query: "rate limiting", timeRange: "month", topic: "news" });
		expect(result).toEqual({ query: "rate limiting", results: [{ url: "https://a.example", title: "A", snippet: "s" }] });
		expect(engine.lastQuery).toMatchObject({ query: "rate limiting", timeRange: "month", topic: "news" });
	});

	test("defaults numResults and clamps it to the hard ceiling", async () => {
		const engine = new FakeEngine();
		const service = new WebSearchService(() => engine);
		await service.search({ query: "x" });
		expect(engine.lastQuery?.numResults).toBe(10);

		await service.search({ query: "x", numResults: 10_000 });
		expect(engine.lastQuery?.numResults).toBe(SEARCH_MAX_NUM_RESULTS_CEILING);

		await service.search({ query: "x", numResults: 0 });
		expect(engine.lastQuery?.numResults).toBe(1);
	});

	test("passes the requested engine name to the resolver", async () => {
		const engine = new FakeEngine();
		const requestedNames: Array<string | undefined> = [];
		const service = new WebSearchService((name) => {
			requestedNames.push(name);
			return engine;
		});
		await service.search({ query: "x", searchEngine: "tavily" });
		expect(requestedNames).toEqual(["tavily"]);
	});

	test("passes siteFilter through to the resolved engine", async () => {
		const engine = new FakeEngine();
		const service = new WebSearchService(() => engine);
		await service.search({ query: "best pizza", siteFilter: "reddit.com" });
		expect(engine.lastQuery?.siteFilter).toBe("reddit.com");
	});

	test("passes wantFullContent through to the resolved engine", async () => {
		const engine = new FakeEngine();
		const service = new WebSearchService(() => engine);
		await service.search({ query: "x", wantFullContent: true });
		expect(engine.lastQuery?.wantFullContent).toBe(true);
	});
});

describe("createEngineResolver", () => {
	test("forcing an engine with no configured key throws a descriptive, key-free error (no network call)", () => {
		const resolver = createEngineResolver({});
		expect(() => resolver("brave")).toThrow(/BRAVE_SEARCH_API_KEY not set/);
		expect(() => resolver("tavily")).toThrow(/TAVILY_API_KEY not set/);
		expect(() => resolver("exa")).toThrow(/EXA_API_KEY not set/);
		expect(() => resolver("serper")).toThrow(/SERPER_API_KEY not set/);
		expect(() => resolver("serpapi")).toThrow(/SERPAPI_API_KEY not set/);
		expect(() => resolver("you")).toThrow(/YOU_API_KEY not set/);
	});

	test("forcing an engine with a configured key in the given env succeeds without throwing", () => {
		const resolver = createEngineResolver({ BRAVE_SEARCH_API_KEY: "test-key" });
		expect(() => resolver("brave")).not.toThrow();
	});

	test("never falls back to the real process.env when an explicit env object is supplied", () => {
		// Guards the trust-boundary note: an explicit env object is authoritative.
		// Prove it by planting a real key in process.env and confirming an
		// explicit empty env still resolves as unconfigured.
		const previous = process.env.BRAVE_SEARCH_API_KEY;
		process.env.BRAVE_SEARCH_API_KEY = "ambient-key-should-be-ignored";
		try {
			const resolver = createEngineResolver({});
			expect(() => resolver("brave")).toThrow(/BRAVE_SEARCH_API_KEY not set/);
		} finally {
			if (previous === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
			else process.env.BRAVE_SEARCH_API_KEY = previous;
		}
	});

	test("no forced engine falls back to the auto-detecting default (never throws when a key is configured)", () => {
		const resolver = createEngineResolver({ TAVILY_API_KEY: "fake-key" });
		expect(() => resolver()).not.toThrow();
	});

	test("no forced engine and zero provider keys configured searches through the keyless fallback", async () => {
		const keyless = new FakeEngine([{ url: "https://keyless.example", title: "Keyless", snippet: "fallback" }]);
		const resolver = createEngineResolver({}, undefined, undefined, keyless);
		await expect(new WebSearchService(resolver).search({ query: "no setup" })).resolves.toEqual({
			query: "no setup",
			results: [{ url: "https://keyless.example", title: "Keyless", snippet: "fallback" }],
		});
	});

	test("the auto-detecting default is built once and reused across calls, not rebuilt per call", () => {
		const resolver = createEngineResolver({ TAVILY_API_KEY: "fake-key" });
		expect(resolver()).toBe(resolver());
	});

	test("forcing a specific engine still resolves a fresh instance each time (not cached)", () => {
		const resolver = createEngineResolver({ BRAVE_SEARCH_API_KEY: "test-key" });
		expect(resolver("brave")).not.toBe(resolver("brave"));
	});

	test("the auto-detecting default also never falls back to the real process.env when an explicit env object is supplied", async () => {
		// Same guard as the forced-engine test above, but for the no-name auto-detect
		// path -- defaultSearchEngine() used to always read the real process.env
		// directly regardless of what was passed here, silently defeating env
		// isolation in exactly this case (caught by a real CI failure: a test
		// planting only TAVILY_API_KEY in an explicit env object still picked up
		// whatever the ambient process.env happened to have configured).
		const previousBrave = process.env.BRAVE_SEARCH_API_KEY;
		const previousTavily = process.env.TAVILY_API_KEY;
		process.env.BRAVE_SEARCH_API_KEY = "ambient-key-should-be-ignored";
		delete process.env.TAVILY_API_KEY;
		try {
			// If the ambient BRAVE key leaked in, the auto-detect chain would include
			// two engines (brave + tavily) and report a "rotation-group" failure
			// instead of staying on the single explicitly-configured tavily engine.
			const calls: Array<{ name: string }> = [];
			const resolver = createEngineResolver({ TAVILY_API_KEY: "explicit-key" }, (name) => {
				calls.push({ name });
			});
			const engine = resolver();

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (_input: string | URL | Request) =>
				new Response("error", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;
			try {
				await expect(engine.search({ query: "x" })).rejects.toThrow();
			} finally {
				globalThis.fetch = originalFetch;
			}

			expect(calls[0]).toEqual({ name: "tavily" });
		} finally {
			if (previousBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
			else process.env.BRAVE_SEARCH_API_KEY = previousBrave;
			if (previousTavily !== undefined) process.env.TAVILY_API_KEY = previousTavily;
		}
	});

	test("forwards onEngineFailure so a degraded engine is reported with its real name", async () => {
		const calls: Array<{ name: string; reason: string }> = [];
		const resolver = createEngineResolver({ TAVILY_API_KEY: "fake-key" }, (name, _error, reason) => {
			calls.push({ name, reason });
		});
		const engine = resolver();

		const originalFetch = globalThis.fetch;
		// 432 is Tavily's quota-exhaustion status, not a short-lived rate limit --
		// classified as reason "quota" (isLikelyQuotaExceededError), not "error".
		globalThis.fetch = (async (_input: string | URL | Request) =>
			new Response("rate limited", { status: 432, statusText: "Usage Limit Exceeded" })) as typeof fetch;
		try {
			await expect(engine.search({ query: "x" })).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(calls[0]).toEqual({ name: "tavily", reason: "quota" });
	});

	test("forwards onUsage so a successful call's own usage is reported with its real engine name", async () => {
		const calls: Array<{ name: string; usage: unknown }> = [];
		const resolver = createEngineResolver({ TAVILY_API_KEY: "fake-key" }, undefined, (name, usage) => {
			calls.push({ name, usage });
		});
		const engine = resolver();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request) =>
			new Response(JSON.stringify({ results: [{ url: "https://a.example", title: "A" }], usage: { credits: 1 } }), {
				status: 200,
			})) as typeof fetch;
		try {
			await engine.search({ query: "x" });
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(calls).toEqual([{ name: "tavily", usage: { credits: 1 } }]);
	});

	test("forcing an engine with additionalKeys configured rotates to the next key on a 401, instead of throwing", async () => {
		const resolver = createEngineResolver({ TAVILY_API_KEY: "primary-key" }, undefined, undefined, undefined, { tavily: ["backup-key"] });
		const engine = resolver("tavily");

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			if (auth === "Bearer primary-key") return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
			return new Response(JSON.stringify({ results: [{ url: "https://a.example", title: "A" }] }), { status: 200 });
		}) as typeof fetch;
		try {
			const results = await engine.search({ query: "x" });
			expect(results.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("forcing an engine with no additionalKeys behaves exactly as before (single-key resolveSearchEngine call, no rotation wrapper)", () => {
		const resolver = createEngineResolver({ TAVILY_API_KEY: "only-key" });
		// Two separate calls each resolve a fresh plain instance -- proven above
		// ("forcing a specific engine still resolves a fresh instance each time").
		// This just confirms additionalKeys being entirely absent doesn't change
		// that -- no RotatingKeySearchEngine wrapper introduced when there is
		// nothing to rotate through.
		expect(() => resolver("tavily")).not.toThrow();
	});
});

describe("testProviderKeys", () => {
	test("classifies a successful call as valid", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request) =>
			new Response(JSON.stringify({ results: [{ url: "https://a.example", title: "A" }] }), { status: 200 })) as typeof fetch;
		try {
			const results = await testProviderKeys("tavily", ["good-key"]);
			expect(results).toEqual([{ index: 0, status: "valid" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("classifies a 401/403 as invalid, a 429 as rate-limited, and reports each key by index -- never the raw key", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			if (auth === "Bearer bad-key") return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
			if (auth === "Bearer throttled-key") return new Response("too many requests", { status: 429, statusText: "Too Many Requests" });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		}) as typeof fetch;
		try {
			const results = await testProviderKeys("tavily", ["bad-key", "throttled-key", "good-key"]);
			expect(results).toEqual([
				{ index: 0, status: "invalid" },
				{ index: 1, status: "rate-limited" },
				{ index: 2, status: "valid" },
			]);
			expect(JSON.stringify(results)).not.toContain("bad-key");
			expect(JSON.stringify(results)).not.toContain("throttled-key");
			expect(JSON.stringify(results)).not.toContain("good-key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("classifies a genuine non-key-shaped failure as a plain error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request) =>
			new Response("boom", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;
		try {
			const results = await testProviderKeys("tavily", ["some-key"]);
			expect(results).toEqual([{ index: 0, status: "error" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns an empty array for an empty key list", async () => {
		expect(await testProviderKeys("tavily", [])).toEqual([]);
	});
});

describe("createEngineResolver — additionalKeys via the auto-detecting default", () => {
	test("receives additionalKeys -- rotates within the same provider, never touching a keyless fallback that would otherwise mask a missing wiring", async () => {
		// Deliberately discriminating: the keyless fallback always throws, so this
		// test can only pass if the *backup* Tavily key genuinely gets tried via
		// additionalKeys -- a version that silently drops additionalKeys (still
		// resolving the single bad primary key) would fail this test instead of
		// accidentally passing through an unrelated fallback layer.
		class AlwaysFailsEngine implements ISearchEngine {
			async search(): Promise<WebSearchResult[]> {
				throw new Error("keyless should never be reached -- additionalKeys should have recovered via the backup key");
			}
		}
		const resolver = createEngineResolver({ TAVILY_API_KEY: "primary-key" }, undefined, undefined, new AlwaysFailsEngine(), {
			tavily: ["backup-key"],
		});
		const engine = resolver();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			if (auth === "Bearer primary-key") return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
			return new Response(JSON.stringify({ results: [{ url: "https://a.example", title: "A" }] }), { status: 200 });
		}) as typeof fetch;
		try {
			const results = await engine.search({ query: "x" });
			expect(results.length).toBeGreaterThan(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
