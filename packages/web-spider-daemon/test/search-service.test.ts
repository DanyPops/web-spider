import { describe, expect, test } from "bun:test";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "@danypops/web-spider";
import { createEngineResolver, WebSearchService } from "../src/search-service.ts";
import { SEARCH_MAX_NUM_RESULTS_CEILING } from "../src/constants.ts";

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
		const service = new WebSearchService((name) => { requestedNames.push(name); return engine; });
		await service.search({ query: "x", searchEngine: "tavily" });
		expect(requestedNames).toEqual(["tavily"]);
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
	});

	test("forcing ddg never requires a key", () => {
		const resolver = createEngineResolver({});
		expect(() => resolver("ddg")).not.toThrow();
	});

	test("forcing an engine with a configured key in the given env succeeds without throwing", () => {
		const resolver = createEngineResolver({ BRAVE_SEARCH_API_KEY: "test-key" });
		expect(() => resolver("brave")).not.toThrow();
	});

	test("never falls back to the real process.env when an explicit env object is supplied", () => {
		// Guards the trust-boundary note: an explicit env object is authoritative.
		// Prove it by planting a real key in process.env and confirming an
		// explicit empty env still resolves as unconfigured.
		const previous = process.env["BRAVE_SEARCH_API_KEY"];
		process.env["BRAVE_SEARCH_API_KEY"] = "ambient-key-should-be-ignored";
		try {
			const resolver = createEngineResolver({});
			expect(() => resolver("brave")).toThrow(/BRAVE_SEARCH_API_KEY not set/);
		} finally {
			if (previous === undefined) delete process.env["BRAVE_SEARCH_API_KEY"];
			else process.env["BRAVE_SEARCH_API_KEY"] = previous;
		}
	});

	test("no forced engine falls back to the auto-detecting default (never throws by itself)", () => {
		const resolver = createEngineResolver({});
		expect(() => resolver()).not.toThrow();
	});

	test("the auto-detecting default is built once and reused across calls, not rebuilt per call", () => {
		const resolver = createEngineResolver({});
		expect(resolver()).toBe(resolver());
	});

	test("forcing a specific engine still resolves a fresh instance each time (not cached)", () => {
		const resolver = createEngineResolver({});
		expect(resolver("ddg")).not.toBe(resolver("ddg"));
	});

	test("the auto-detecting default also never falls back to the real process.env when an explicit env object is supplied", async () => {
		// Same guard as the forced-engine test above, but for the no-name auto-detect
		// path -- defaultSearchEngine() used to always read the real process.env
		// directly regardless of what was passed here, silently defeating env
		// isolation in exactly this case (caught by a real CI failure: a test
		// planting only TAVILY_API_KEY in an explicit env object still picked up
		// whatever the ambient process.env happened to have configured).
		const previousBrave = process.env["BRAVE_SEARCH_API_KEY"];
		const previousTavily = process.env["TAVILY_API_KEY"];
		process.env["BRAVE_SEARCH_API_KEY"] = "ambient-key-should-be-ignored";
		delete process.env["TAVILY_API_KEY"];
		try {
			// If the ambient BRAVE key leaked in, the auto-detect chain would include
			// two engines (brave + tavily) and report a "rotation-group" failure
			// instead of staying on the single explicitly-configured tavily engine.
			const calls: Array<{ name: string }> = [];
			const resolver = createEngineResolver({ TAVILY_API_KEY: "explicit-key" }, (name) => { calls.push({ name }); });
			const engine = resolver();

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (_input: string | URL | Request) => new Response("error", { status: 500, statusText: "Internal Server Error" })) as typeof fetch;
			try {
				await expect(engine.search({ query: "x" })).rejects.toThrow();
			} finally {
				globalThis.fetch = originalFetch;
			}

			expect(calls[0]).toEqual({ name: "tavily" });
		} finally {
			if (previousBrave === undefined) delete process.env["BRAVE_SEARCH_API_KEY"];
			else process.env["BRAVE_SEARCH_API_KEY"] = previousBrave;
			if (previousTavily !== undefined) process.env["TAVILY_API_KEY"] = previousTavily;
		}
	});

	test("forwards onEngineFailure so a degraded engine is reported with its real name", async () => {
		const calls: Array<{ name: string; reason: string }> = [];
		const resolver = createEngineResolver({ TAVILY_API_KEY: "fake-key" }, (name, _error, reason) => { calls.push({ name, reason }); });
		const engine = resolver();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request) => new Response("rate limited", { status: 432, statusText: "Usage Limit Exceeded" })) as typeof fetch;
		try {
			await expect(engine.search({ query: "x" })).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(calls[0]).toEqual({ name: "tavily", reason: "error" });
	});
});
