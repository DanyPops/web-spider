import { describe, expect, it } from "bun:test";
import type { TryEnigmaAccessToken } from "@danypops/enigma-client";
import { resolveSearchEnv } from "../src/search-env.ts";

/**
 * Never the real tryEnigmaAccessToken in a test: it does a real filesystem
 * check against $XDG_RUNTIME_DIR, and a real Enigma daemon may genuinely be
 * running on the machine executing this suite -- tests must never depend on
 * ambient host state.
 */
const noEnigma: TryEnigmaAccessToken = async () => undefined;

describe("resolveSearchEnv", () => {
	it("leaves the base env untouched when Enigma has nothing configured", async () => {
		const baseEnv = { TAVILY_API_KEY: "static-key", UNRELATED: "x" };
		const env = await resolveSearchEnv(baseEnv, noEnigma);
		expect(env).toEqual(baseEnv);
	});

	it("fills in a provider's env var from Enigma when Enigma has a credential for it", async () => {
		const fromEnigma: TryEnigmaAccessToken = async (backend) => (backend === "brave" ? "brave-vault-key" : undefined);
		const env = await resolveSearchEnv({}, fromEnigma);
		expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
		expect(env.TAVILY_API_KEY).toBeUndefined();
		expect(env.EXA_API_KEY).toBeUndefined();
	});

	it("prefers Enigma's value over an existing static env var for the same provider", async () => {
		const fromEnigma: TryEnigmaAccessToken = async (backend) => (backend === "tavily" ? "vault-tavily-key" : undefined);
		const env = await resolveSearchEnv({ TAVILY_API_KEY: "stale-static-key" }, fromEnigma);
		expect(env.TAVILY_API_KEY).toBe("vault-tavily-key");
	});

	it("resolves every known engine's backend independently, one missing does not block another", async () => {
		const fromEnigma: TryEnigmaAccessToken = async (backend) => {
			if (backend === "brave") return "b-key";
			if (backend === "exa") return "e-key";
			return undefined;
		};
		const env = await resolveSearchEnv({ TAVILY_API_KEY: "static-tavily" }, fromEnigma);
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(env.EXA_API_KEY).toBe("e-key");
		expect(env.TAVILY_API_KEY).toBe("static-tavily");
	});

	it("never fails just because Enigma's own lookup rejects -- defensively contained even though the real tryEnigmaAccessToken never throws", async () => {
		const throwingEnigma: TryEnigmaAccessToken = async () => {
			throw new Error("boom");
		};
		const env = await resolveSearchEnv({ TAVILY_API_KEY: "static" }, throwingEnigma);
		expect(env.TAVILY_API_KEY).toBe("static");
	});

	it("one provider's failure does not block another's successful Enigma lookup", async () => {
		const mixedEnigma: TryEnigmaAccessToken = async (backend) => {
			if (backend === "brave") throw new Error("boom");
			if (backend === "exa") return "e-key";
			return undefined;
		};
		const env = await resolveSearchEnv({ BRAVE_SEARCH_API_KEY: "static-brave" }, mixedEnigma);
		expect(env.BRAVE_SEARCH_API_KEY).toBe("static-brave");
		expect(env.EXA_API_KEY).toBe("e-key");
	});

	it("passes ENIGMA_CLIENT_TOKEN from baseEnv through to every backend lookup -- the registered-client seam, since Enigma's shared admin-token file is not readable outside its own service account", async () => {
		const seenTokens: Array<string | undefined> = [];
		const fromEnigma: TryEnigmaAccessToken = async (backend, opts) => {
			seenTokens.push(opts?.token);
			return backend === "brave" ? "b-key" : undefined;
		};
		const env = await resolveSearchEnv({ ENIGMA_CLIENT_TOKEN: "web-spider-own-token" }, fromEnigma);
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(seenTokens.every((t) => t === "web-spider-own-token")).toBe(true);
	});

	it("omitting ENIGMA_CLIENT_TOKEN passes an undefined token through, same as an unmigrated caller today", async () => {
		const seenTokens: Array<string | undefined> = [];
		const fromEnigma: TryEnigmaAccessToken = async (_backend, opts) => {
			seenTokens.push(opts?.token);
			return undefined;
		};
		await resolveSearchEnv({}, fromEnigma);
		expect(seenTokens.every((t) => t === undefined)).toBe(true);
	});
});
