/**
 * Integration tests — real network, but never dependent on account
 * quota/credits: only auth-failure and configuration-error paths.
 *
 * Tests that consumed real search quota (a straightforward Tavily query,
 * webSearch() auto-detect against a real key, etc.) were removed -- they
 * made this suite's pass/fail depend on an external account's remaining
 * balance rather than on this package's own behavior. That coverage
 * (result mapping, field shapes) is exercised against mocked fetch in
 * web-search.test.ts instead.
 */

import { describe, expect, it } from "vitest";
import { tavilySearch, webSearch } from "../src/web-search/index.js";

describe("tavilySearch() — live Tavily API", () => {
	it("throws a clear error when the key is wrong", async () => {
		// An invalid key is rejected during authentication, before any quota
		// check -- this assertion holds regardless of the real account's
		// remaining balance.
		await expect(tavilySearch("test", { apiKey: "tvly-invalid-key-000" })).rejects.toThrow(/tavily/i);
	});
});

describe("webSearch() — auto-detect configuration errors", () => {
	it("throws a descriptive error when forced to 'brave' with no key set", async () => {
		const saved = process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.BRAVE_SEARCH_API_KEY;
		await expect(webSearch("test", { engine: "brave" })).rejects.toThrow("BRAVE_SEARCH_API_KEY");
		if (saved) process.env.BRAVE_SEARCH_API_KEY = saved;
	});
});
