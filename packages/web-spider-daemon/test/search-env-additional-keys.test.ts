/**
 * BYOK key stacking: resolveAdditionalSearchKeys() exposes every key beyond
 * the primary one already merged into resolveSearchEnv()'s env, for
 * createEngineResolver's additionalKeys wiring. Only the local file-store
 * tier supports multiple keys -- raw process env and Enigma remain
 * single-value tiers, unchanged by this.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAdditionalSearchKeys } from "../src/search/search-env.ts";
import { createSearchKeyStore } from "../src/search/search-secrets.ts";

describe("resolveAdditionalSearchKeys", () => {
	it("returns an empty object when nothing is stored", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-additional-keys-"));
		try {
			expect(resolveAdditionalSearchKeys(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("omits a provider with only one stored key -- nothing additional beyond the primary", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-additional-keys-"));
		try {
			createSearchKeyStore(dir, "brave").add("only-key");
			expect(resolveAdditionalSearchKeys(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns every key after the first (primary) for a provider with several stacked", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-additional-keys-"));
		try {
			const store = createSearchKeyStore(dir, "tavily");
			store.add("key-1");
			store.add("key-2");
			store.add("key-3");
			expect(resolveAdditionalSearchKeys(dir)).toEqual({ tavily: ["key-2", "key-3"] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports every provider with more than one key, independently", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-additional-keys-"));
		try {
			const brave = createSearchKeyStore(dir, "brave");
			brave.add("b1");
			brave.add("b2");
			const you = createSearchKeyStore(dir, "you");
			you.add("y1"); // single key -- not reported
			expect(resolveAdditionalSearchKeys(dir)).toEqual({ brave: ["b2"] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
