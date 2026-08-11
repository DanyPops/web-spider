/**
 * TDD tests for the ContentSourceStrategy registry (src/sources/registry.ts).
 * Mirrors test/engine-registry.test.ts's shape for the sibling search-engine
 * registry: adding a new site adapter must not require editing existing code.
 */
import { describe, expect, it } from "vitest";
import type { ContentSourceStrategy } from "../src/index.js";
import { buildRegisteredContentSources, listRegisteredContentSources, registerContentSource, resolveContentSources } from "../src/index.js";

describe("registerContentSource / resolveContentSources", () => {
	it("built-in strategies are registered out of the box", () => {
		const names = listRegisteredContentSources();
		expect(names).toContain("llms-txt");
		expect(names).toContain("markdown-suffix");
		expect(names).toContain("github");
		expect(names).toContain("mediawiki");
		expect(names).toContain("youtube");
	});

	it("resolves a built-in strategy by name into a real ContentSourceStrategy", () => {
		const [github] = resolveContentSources(["github"]);
		expect(github.name).toBe("github");
		expect(typeof github.matches).toBe("function");
		expect(typeof github.fetch).toBe("function");
	});

	it("resolves several strategies in the requested order, not registration order", () => {
		const resolved = resolveContentSources(["mediawiki", "github"]);
		expect(resolved.map((s) => s.name)).toEqual(["mediawiki", "github"]);
	});

	it("throws a descriptive error for an unknown name", () => {
		expect(() => resolveContentSources(["does-not-exist"])).toThrow(/does-not-exist/);
	});

	it("a third-party strategy can be registered without editing existing code", () => {
		const stub: ContentSourceStrategy = { name: "my-custom-site", matches: () => true, fetch: async () => null };
		registerContentSource("my-custom-site", () => stub);

		expect(listRegisteredContentSources()).toContain("my-custom-site");
		expect(resolveContentSources(["my-custom-site"])[0]).toBe(stub);
	});

	it("registering an existing name overwrites it in place, everything else unaffected", () => {
		const before = listRegisteredContentSources();
		const first: ContentSourceStrategy = { name: "overwrite-test", matches: () => true, fetch: async () => null };
		const second: ContentSourceStrategy = { name: "overwrite-test", matches: () => true, fetch: async () => null };
		registerContentSource("overwrite-test", () => first);
		registerContentSource("overwrite-test", () => second);

		expect(resolveContentSources(["overwrite-test"])[0]).toBe(second);
		expect(listRegisteredContentSources().filter((n) => n === "overwrite-test")).toHaveLength(1);
		expect(listRegisteredContentSources().length).toBe(before.length + 1);
	});

	it("buildRegisteredContentSources() returns a fresh instance of every registered strategy", () => {
		const all = buildRegisteredContentSources();
		expect(all.length).toBeGreaterThanOrEqual(listRegisteredContentSources().length);
		expect(all.every((s) => typeof s.matches === "function" && typeof s.fetch === "function")).toBe(true);
	});
});
