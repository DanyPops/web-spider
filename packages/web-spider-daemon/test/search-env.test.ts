import { describe, expect, it } from "bun:test";
import type { EnigmaWhoAmI, TryEnigmaCredential, TryEnigmaWhoAmI, VaultCredential } from "@danypops/enigma-client";
import { resolveSearchEnv } from "../src/search-env.ts";

/**
 * Never the real Enigma client functions in a test: they do a real
 * filesystem check against $XDG_RUNTIME_DIR, and a real Enigma daemon may
 * genuinely be running on the machine executing this suite -- tests must
 * never depend on ambient host state.
 */
function fakeDeps(who: EnigmaWhoAmI | undefined, credentials: Record<string, VaultCredential>) {
	const tryWhoAmI: TryEnigmaWhoAmI = async () => who;
	const tryCredential: TryEnigmaCredential = async (backend) => credentials[backend];
	return { tryWhoAmI, tryCredential };
}

describe("resolveSearchEnv", () => {
	it("leaves the base env untouched when Enigma reports no registration at all", async () => {
		const baseEnv = { TAVILY_API_KEY: "static-key", UNRELATED: "x" };
		const env = await resolveSearchEnv(baseEnv, fakeDeps(undefined, {}));
		expect(env).toEqual(baseEnv);
	});

	it("leaves the base env untouched when this client is registered for zero backends", async () => {
		const baseEnv = { TAVILY_API_KEY: "static-key" };
		const env = await resolveSearchEnv(baseEnv, fakeDeps({ name: "web-spider", backends: [] }, {}));
		expect(env).toEqual(baseEnv);
	});

	it("fills in the env var declared on the credential's own extra.envVarName -- no hardcoded backend-to-env-var mapping", async () => {
		const who = { name: "web-spider", backends: ["Brave"] };
		const credentials = { Brave: { accessToken: "brave-vault-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({}, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
	});

	it("resolves every backend this client is registered for, one at a time, independent env vars", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Tavily", "Exa"] };
		const credentials = {
			Brave: { accessToken: "b-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } },
			Tavily: { accessToken: "t-key", extra: { envVarName: "TAVILY_API_KEY" } },
			Exa: { accessToken: "e-key", extra: { envVarName: "EXA_API_KEY" } },
		};
		const env = await resolveSearchEnv({ TAVILY_API_KEY: "stale-static" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(env.TAVILY_API_KEY).toBe("t-key");
		expect(env.EXA_API_KEY).toBe("e-key");
	});

	it("skips a backend whose stored credential has no extra.envVarName -- nothing safe to do with it", async () => {
		const who = { name: "web-spider", backends: ["Weird"] };
		const credentials = { Weird: { accessToken: "weird-key" } };
		const env = await resolveSearchEnv({ UNRELATED: "x" }, fakeDeps(who, credentials));
		expect(env).toEqual({ UNRELATED: "x" });
	});

	it("skips a registered backend Enigma has no credential for (404-shaped undefined)", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Tavily"] };
		const credentials = { Brave: { accessToken: "b-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({}, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(env.TAVILY_API_KEY).toBeUndefined();
	});

	it("never fails just because whoami itself rejects -- defensively contained even though the real client never throws", async () => {
		const tryWhoAmI: TryEnigmaWhoAmI = async () => {
			throw new Error("boom");
		};
		const env = await resolveSearchEnv({ TAVILY_API_KEY: "static" }, { tryWhoAmI });
		expect(env).toEqual({ TAVILY_API_KEY: "static" });
	});

	it("one backend's credential lookup failing does not block another's", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Exa"] };
		const tryCredential: TryEnigmaCredential = async (backend) => {
			if (backend === "Brave") throw new Error("boom");
			return { accessToken: "e-key", extra: { envVarName: "EXA_API_KEY" } };
		};
		const env = await resolveSearchEnv({ BRAVE_SEARCH_API_KEY: "static-brave" }, { tryWhoAmI: async () => who, tryCredential });
		expect(env.BRAVE_SEARCH_API_KEY).toBe("static-brave");
		expect(env.EXA_API_KEY).toBe("e-key");
	});

	it("passes ENIGMA_CLIENT_TOKEN from baseEnv through to both whoami and every credential lookup", async () => {
		const seenTokens: Array<string | undefined> = [];
		const tryWhoAmI: TryEnigmaWhoAmI = async (opts) => {
			seenTokens.push(opts?.token);
			return { name: "web-spider", backends: ["Brave"] };
		};
		const tryCredential: TryEnigmaCredential = async (_backend, opts) => {
			seenTokens.push(opts?.token);
			return { accessToken: "b-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } };
		};
		await resolveSearchEnv({ ENIGMA_CLIENT_TOKEN: "web-spider-own-token" }, { tryWhoAmI, tryCredential });
		expect(seenTokens.every((t) => t === "web-spider-own-token")).toBe(true);
	});
});
