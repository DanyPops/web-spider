/**
 * TDD tests for the search engine registry.
 *
 * Adding a new engine must not require editing existing code —
 * only registering a new entry.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import {
	BraveSearchEngine,
	defaultSearchEngine,
	ExaSearchEngine,
	registerSearchEngine,
	resolveSearchEngine,
	SerperSearchEngine,
	TavilySearchEngine,
} from "../src/web-search/index.js";

// ---------------------------------------------------------------------------
// Stub engine — used to verify registration without touching real APIs
// ---------------------------------------------------------------------------

class StubEngine implements ISearchEngine {
	readonly calls: SearchQuery[] = [];
	constructor(private readonly results: WebSearchResult[] = []) {}
	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		this.calls.push(req);
		return this.results;
	}
}

// ---------------------------------------------------------------------------
// Registry — registerSearchEngine / resolveSearchEngine
// ---------------------------------------------------------------------------

describe("registerSearchEngine / resolveSearchEngine", () => {
	it("resolves a built-in engine by name without editing existing code", () => {
		const engine = resolveSearchEngine("serper", "test-serper-key");
		expect(engine).toBeInstanceOf(SerperSearchEngine);
	});

	it("resolves brave when BRAVE_SEARCH_API_KEY is set", () => {
		const engine = resolveSearchEngine("brave", "test-brave-key");
		expect(engine).toBeInstanceOf(BraveSearchEngine);
	});

	it("resolves tavily when TAVILY_API_KEY is set", () => {
		const engine = resolveSearchEngine("tavily", "test-tavily-key");
		expect(engine).toBeInstanceOf(TavilySearchEngine);
	});

	it("resolves exa when EXA_API_KEY is set", () => {
		const engine = resolveSearchEngine("exa", "test-exa-key");
		expect(engine).toBeInstanceOf(ExaSearchEngine);
	});

	it("throws a descriptive error when key is missing for a keyed engine", () => {
		expect(() => resolveSearchEngine("brave", undefined)).toThrow(/BRAVE_SEARCH_API_KEY/);
		expect(() => resolveSearchEngine("tavily", undefined)).toThrow(/TAVILY_API_KEY/);
		expect(() => resolveSearchEngine("exa", undefined)).toThrow(/EXA_API_KEY/);
	});

	it("throws for an unknown engine name", () => {
		expect(() => resolveSearchEngine("unknown-engine" as never, undefined)).toThrow(/unknown.*engine/i);
	});

	it("a third-party engine can be registered without editing existing code", () => {
		const stub = new StubEngine([{ url: "https://test.com", title: "Test", snippet: "ok" }]);
		registerSearchEngine("my-custom-engine", () => stub);

		const resolved = resolveSearchEngine("my-custom-engine" as never, undefined);
		expect(resolved).toBe(stub);
	});

	it("registered engine is callable and returns results", async () => {
		const stub = new StubEngine([{ url: "https://custom.com", title: "Custom", snippet: "result" }]);
		registerSearchEngine("test-engine-2", () => stub);

		const engine = resolveSearchEngine("test-engine-2" as never, undefined);
		const results = await engine.search({ query: "hello", numResults: 5 });
		expect(results[0].url).toBe("https://custom.com");
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0].query).toBe("hello");
	});

	it("registered engine overwrites a previous registration for the same name", () => {
		const first = new StubEngine();
		const second = new StubEngine();
		registerSearchEngine("overwrite-test", () => first);
		registerSearchEngine("overwrite-test", () => second);

		const resolved = resolveSearchEngine("overwrite-test" as never, undefined);
		expect(resolved).toBe(second);
	});
});

// ---------------------------------------------------------------------------
// defaultSearchEngine — still builds the right chain from env vars
// ---------------------------------------------------------------------------

describe("defaultSearchEngine", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("returns an ISearchEngine when at least one provider key is configured", () => {
		process.env.TAVILY_API_KEY = "fake-key";
		const engine = defaultSearchEngine();
		expect(typeof engine.search).toBe("function");
	});

	it("throws a clear error when no provider key is configured", () => {
		for (const key of ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SERPAPI_API_KEY"]) {
			delete process.env[key];
		}
		expect(() => defaultSearchEngine()).toThrow(/no search engine api key configured/i);
	});
});
