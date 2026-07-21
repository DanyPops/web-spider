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
});
