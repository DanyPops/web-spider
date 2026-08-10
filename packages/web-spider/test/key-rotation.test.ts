/**
 * Unit tests for RotatingKeySearchEngine -- BYOK key stacking for a single
 * search provider: on a rate-limit/invalid-key failure, rotate to the next
 * stored key for the *same* provider before ever falling back to a
 * different provider. No network calls -- every inner ISearchEngine
 * factory is stubbed.
 */

import { describe, expect, it, vi } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import {
	createDefaultKeyCooldownPolicy,
	isLikelyInvalidKeyError,
	type KeyFailureKind,
	RotatingKeySearchEngine,
} from "../src/web-search/composites/key-rotation.js";

const RESULT_A: WebSearchResult = { url: "https://a.example", title: "A", snippet: "snippet a" };
const REQ: SearchQuery = { query: "test query", numResults: 5 };

function okEngine(results: WebSearchResult[]): ISearchEngine {
	return { search: vi.fn().mockResolvedValue(results) };
}

function failEngine(message = "engine error"): ISearchEngine {
	return { search: vi.fn().mockRejectedValue(new Error(message)) };
}

describe("RotatingKeySearchEngine — construction", () => {
	it("throws for an empty key list", () => {
		expect(() => new RotatingKeySearchEngine([], () => okEngine([]))).toThrow("at least one key");
	});

	it("does not throw for a single key", () => {
		expect(() => new RotatingKeySearchEngine(["k1"], () => okEngine([]))).not.toThrow();
	});
});

describe("RotatingKeySearchEngine — happy path", () => {
	it("builds an engine for the (only) key and returns its results", async () => {
		const build = vi.fn().mockReturnValue(okEngine([RESULT_A]));
		const engine = new RotatingKeySearchEngine(["k1"], build);
		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_A]);
		expect(build).toHaveBeenCalledWith("k1");
	});
});

describe("RotatingKeySearchEngine — rotation on 429", () => {
	it("rotates to the next key when the first is rate-limited (429)", async () => {
		const engines = new Map<string, ISearchEngine>([
			["k1", failEngine("429 Too Many Requests")],
			["k2", okEngine([RESULT_A])],
		]);
		const build = vi.fn((key: string) => engines.get(key) as ISearchEngine);
		const engine = new RotatingKeySearchEngine(["k1", "k2"], build);

		const results = await engine.search(REQ);

		expect(results).toEqual([RESULT_A]);
		expect(build).toHaveBeenNthCalledWith(1, "k1");
		expect(build).toHaveBeenNthCalledWith(2, "k2");
	});

	it("does not retry the rate-limited key again within its cooldown window on a later call", async () => {
		let now = 1_000_000;
		const k1 = failEngine("429 Too Many Requests");
		const k2 = okEngine([RESULT_A]);
		const build = vi.fn((key: string) => (key === "k1" ? k1 : k2));
		const engine = new RotatingKeySearchEngine(["k1", "k2"], build, { now: () => now });

		await engine.search(REQ); // k1 fails (429), rotates to k2
		build.mockClear();
		(k1.search as ReturnType<typeof vi.fn>).mockClear();

		now += 1_000; // still well within the default 60s rate-limit cooldown
		await engine.search(REQ);

		expect(k1.search).not.toHaveBeenCalled();
		expect(build).toHaveBeenCalledWith("k2");
	});

	it("retries a previously rate-limited key again once its cooldown has elapsed", async () => {
		let now = 1_000_000;
		const k1 = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue([RESULT_A]);
		const build = vi.fn(() => ({ search: k1 }));
		const engine = new RotatingKeySearchEngine(["k1"], build, { now: () => now });

		await expect(engine.search(REQ)).rejects.toThrow(); // only key, rate-limited, exhausted
		now += 61_000; // past the default 60s rate-limit cooldown

		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_A]);
	});
});

describe("RotatingKeySearchEngine — cooldown durations by failure kind", () => {
	it("uses a 60s cooldown for a rate-limited key by default", async () => {
		let now = 0;
		const onKeyFailure = vi.fn();
		const engine = new RotatingKeySearchEngine(["k1", "k2"], (key) => (key === "k1" ? failEngine("429") : okEngine([RESULT_A])), {
			now: () => now,
			onKeyFailure,
		});
		await engine.search(REQ);
		expect(onKeyFailure).toHaveBeenCalledWith(0, expect.any(Error), "rate-limited" satisfies KeyFailureKind);

		// Just short of 60s: still in cooldown.
		now = 59_000;
		const build2 = vi.fn((key: string) => (key === "k1" ? failEngine("should not be called") : okEngine([RESULT_A])));
		const engine2 = new RotatingKeySearchEngine(["k1", "k2"], build2, { now: () => now });
		// Fresh instance has no cooldown state yet -- this proves the *policy* value (60s) via createDefaultKeyCooldownPolicy directly instead.
		expect(createDefaultKeyCooldownPolicy().cooldownMs("rate-limited")).toBe(60_000);
	});

	it("uses a 300s cooldown for an invalid key (401/403) by default", () => {
		expect(createDefaultKeyCooldownPolicy().cooldownMs("invalid")).toBe(300_000);
	});

	it("classifies a 401/403 response as an invalid-key failure, not rate-limited", async () => {
		const onKeyFailure = vi.fn();
		const engine = new RotatingKeySearchEngine(
			["k1", "k2"],
			(key) => (key === "k1" ? failEngine("401 Unauthorized") : okEngine([RESULT_A])),
			{
				onKeyFailure,
			},
		);
		await engine.search(REQ);
		expect(onKeyFailure).toHaveBeenCalledWith(0, expect.any(Error), "invalid" satisfies KeyFailureKind);
	});

	it("respects a custom cooldown policy", async () => {
		let now = 0;
		const k1 = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue([RESULT_A]);
		const engine = new RotatingKeySearchEngine(["k1"], () => ({ search: k1 }), {
			now: () => now,
			cooldownPolicy: { cooldownMs: () => 5_000 },
		});
		await expect(engine.search(REQ)).rejects.toThrow();
		now = 4_999;
		await expect(engine.search(REQ)).rejects.toThrow(); // still in cooldown (custom 5s policy)
		now = 5_001;
		const results = await engine.search(REQ);
		expect(results).toEqual([RESULT_A]);
	});
});

describe("RotatingKeySearchEngine — exhaustion falls back further only when every key is exhausted", () => {
	it("throws once every key is rate-limited/invalid, so the caller (an outer provider-level composite) can fall back further", async () => {
		const engine = new RotatingKeySearchEngine(["k1", "k2"], (key) => (key === "k1" ? failEngine("429") : failEngine("403 Forbidden")));
		await expect(engine.search(REQ)).rejects.toThrow();
	});

	it("does not rotate keys for a genuine non-key-shaped error (e.g. a network failure) -- rethrows immediately", async () => {
		const k2 = okEngine([RESULT_A]);
		const build = vi.fn((key: string) => (key === "k1" ? failEngine("ECONNRESET") : k2));
		const engine = new RotatingKeySearchEngine(["k1", "k2"], build);

		await expect(engine.search(REQ)).rejects.toThrow("ECONNRESET");
		expect(build).toHaveBeenCalledTimes(1); // never even tried k2 -- not a key problem
	});
});

describe("isLikelyInvalidKeyError", () => {
	it("recognizes 401/403 and common phrasing", () => {
		expect(isLikelyInvalidKeyError(new Error("401 Unauthorized"))).toBe(true);
		expect(isLikelyInvalidKeyError(new Error("403 Forbidden"))).toBe(true);
		expect(isLikelyInvalidKeyError(new Error("Invalid API key"))).toBe(true);
		expect(isLikelyInvalidKeyError(new Error("unauthorized"))).toBe(true);
	});

	it("is false for an unrelated error", () => {
		expect(isLikelyInvalidKeyError(new Error("ECONNRESET"))).toBe(false);
		expect(isLikelyInvalidKeyError("not an Error instance")).toBe(false);
	});
});
