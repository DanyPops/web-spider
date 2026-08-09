import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnigmaWhoAmI, TryEnigmaCredential, TryEnigmaWhoAmI, VaultCredential } from "@danypops/enigma-client";
import { resolveEnigmaConfigPath, saveEnigmaConfig } from "../src/search/enigma-config.ts";
import { resolveSearchEnv } from "../src/search/search-env.ts";
import { createSearchKeyStore } from "../src/search/search-secrets.ts";
import { resolveWebSpiderPaths } from "../src/state.ts";

/**
 * Never a real filesystem path this machine might actually have search
 * keys stored under, and never the real Enigma client functions -- a real
 * Enigma daemon may genuinely be running on the machine executing this
 * suite, and this machine's own `~/.local/state/web-spider/search-keys/`
 * may genuinely hold real keys. Tests must never depend on ambient host
 * state; every test below passes its own isolated, guaranteed-empty
 * searchKeysDir unless it's specifically exercising that tier.
 */
const NO_LOCAL_KEYS_DIR = "/nonexistent-search-keys-dir-for-tests";

function fakeDeps(who: EnigmaWhoAmI | undefined, credentials: Record<string, VaultCredential>) {
	const tryWhoAmI: TryEnigmaWhoAmI = async () => who;
	const tryCredential: TryEnigmaCredential = async (backend) => credentials[backend];
	return { tryWhoAmI, tryCredential, searchKeysDir: NO_LOCAL_KEYS_DIR };
}

describe("resolveSearchEnv: local file-store tier", () => {
	it("leaves the base env untouched when nothing is stored locally", async () => {
		const baseEnv = { TAVILY_API_KEY: "static-key" };
		const env = await resolveSearchEnv(baseEnv, { searchKeysDir: NO_LOCAL_KEYS_DIR, useEnigma: false });
		expect(env).toEqual(baseEnv);
	});

	it("fills in an engine's env var from a locally stored key, with no static env var present at all", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "brave").save("stored-brave-key");
			const env = await resolveSearchEnv({}, { searchKeysDir: dir, useEnigma: false });
			expect(env.BRAVE_SEARCH_API_KEY).toBe("stored-brave-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a locally stored key overrides a static env var for the same engine (env is the weakest tier)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "tavily").save("stored-tavily-key");
			const env = await resolveSearchEnv({ TAVILY_API_KEY: "stale-env-key" }, { searchKeysDir: dir, useEnigma: false });
			expect(env.TAVILY_API_KEY).toBe("stored-tavily-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves every engine independently -- one stored key never leaks into another engine's env var", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "exa").save("stored-exa-key");
			const env = await resolveSearchEnv({ TAVILY_API_KEY: "static-tavily" }, { searchKeysDir: dir, useEnigma: false });
			expect(env.EXA_API_KEY).toBe("stored-exa-key");
			expect(env.TAVILY_API_KEY).toBe("static-tavily");
			expect(env.BRAVE_SEARCH_API_KEY).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Enigma still wins over a locally stored key when both are opted into and both supply a value", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "brave").save("stored-local-key");
			const who = { name: "web-spider", backends: ["Brave"] };
			const credentials = { Brave: { accessToken: "enigma-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
			const env = await resolveSearchEnv(
				{ WEB_SPIDER_USE_ENIGMA: "1" },
				{ searchKeysDir: dir, tryWhoAmI: async () => who, tryCredential: async () => credentials.Brave },
			);
			expect(env.BRAVE_SEARCH_API_KEY).toBe("enigma-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not require WEB_SPIDER_USE_ENIGMA -- the local store is unconditional, unlike Enigma", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "you").save("stored-you-key");
			const env = await resolveSearchEnv({}, { searchKeysDir: dir, useEnigma: false });
			expect(env.YOU_API_KEY).toBe("stored-you-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSearchEnv: opt-in switch", () => {
	it("never calls Enigma at all when WEB_SPIDER_USE_ENIGMA is unset -- reachable is not the same as wanted", async () => {
		let called = false;
		const tryWhoAmI: TryEnigmaWhoAmI = async () => {
			called = true;
			return { name: "web-spider", backends: ["Brave"] };
		};
		const baseEnv = { TAVILY_API_KEY: "static-key" };
		const env = await resolveSearchEnv(baseEnv, { tryWhoAmI, searchKeysDir: NO_LOCAL_KEYS_DIR, useEnigma: false });
		expect(called).toBe(false);
		expect(env).toEqual(baseEnv);
	});

	it("never calls Enigma for an explicit falsy value (WEB_SPIDER_USE_ENIGMA=0)", async () => {
		let called = false;
		const tryWhoAmI: TryEnigmaWhoAmI = async () => {
			called = true;
			return { name: "web-spider", backends: ["Brave"] };
		};
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "0" }, { tryWhoAmI, searchKeysDir: NO_LOCAL_KEYS_DIR });
		expect(called).toBe(false);
		expect(env.WEB_SPIDER_USE_ENIGMA).toBe("0");
	});

	it("calls Enigma when WEB_SPIDER_USE_ENIGMA=1", async () => {
		const who = { name: "web-spider", backends: ["Brave"] };
		const credentials = { Brave: { accessToken: "brave-vault-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "1" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
	});

	it("calls Enigma when WEB_SPIDER_USE_ENIGMA=true", async () => {
		const who = { name: "web-spider", backends: ["Brave"] };
		const credentials = { Brave: { accessToken: "brave-vault-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "true" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
	});

	it("calls Enigma from the persisted opt-in without service environment data", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-enigma-config-"));
		try {
			const baseEnv = { XDG_STATE_HOME: dir };
			saveEnigmaConfig(resolveEnigmaConfigPath(resolveWebSpiderPaths({ env: baseEnv })), { useEnigma: true });
			const env = await resolveSearchEnv(baseEnv, {
				tryWhoAmI: async () => ({ name: "web-spider", backends: ["Brave"] }),
				tryCredential: async () => ({ accessToken: "brave-vault-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } }),
			});
			expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
			expect(env.ENIGMA_CLIENT_TOKEN).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSearchEnv: Enigma tier", () => {
	it("leaves the base env untouched when Enigma reports no registration at all", async () => {
		const baseEnv = { WEB_SPIDER_USE_ENIGMA: "1", TAVILY_API_KEY: "static-key", UNRELATED: "x" };
		const env = await resolveSearchEnv(baseEnv, fakeDeps(undefined, {}));
		expect(env).toEqual(baseEnv);
	});

	it("leaves the base env untouched when this client is registered for zero backends", async () => {
		const baseEnv = { WEB_SPIDER_USE_ENIGMA: "1", TAVILY_API_KEY: "static-key" };
		const env = await resolveSearchEnv(baseEnv, fakeDeps({ name: "web-spider", backends: [] }, {}));
		expect(env).toEqual(baseEnv);
	});

	it("fills in the env var declared on the credential's own extra.envVarName -- no hardcoded backend-to-env-var mapping", async () => {
		const who = { name: "web-spider", backends: ["Brave"] };
		const credentials = { Brave: { accessToken: "brave-vault-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "1" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("brave-vault-key");
	});

	it("resolves every backend this client is registered for, one at a time, independent env vars", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Tavily", "Exa"] };
		const credentials = {
			Brave: { accessToken: "b-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } },
			Tavily: { accessToken: "t-key", extra: { envVarName: "TAVILY_API_KEY" } },
			Exa: { accessToken: "e-key", extra: { envVarName: "EXA_API_KEY" } },
		};
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "1", TAVILY_API_KEY: "stale-static" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(env.TAVILY_API_KEY).toBe("t-key");
		expect(env.EXA_API_KEY).toBe("e-key");
	});

	it("skips a backend whose stored credential has no extra.envVarName -- nothing safe to do with it", async () => {
		const who = { name: "web-spider", backends: ["Weird"] };
		const credentials = { Weird: { accessToken: "weird-key" } };
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "1", UNRELATED: "x" }, fakeDeps(who, credentials));
		expect(env).toEqual({ WEB_SPIDER_USE_ENIGMA: "1", UNRELATED: "x" });
	});

	it("skips a registered backend Enigma has no credential for (404-shaped undefined)", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Tavily"] };
		const credentials = { Brave: { accessToken: "b-key", extra: { envVarName: "BRAVE_SEARCH_API_KEY" } } };
		const env = await resolveSearchEnv({ WEB_SPIDER_USE_ENIGMA: "1" }, fakeDeps(who, credentials));
		expect(env.BRAVE_SEARCH_API_KEY).toBe("b-key");
		expect(env.TAVILY_API_KEY).toBeUndefined();
	});

	it("never fails just because whoami itself rejects -- defensively contained even though the real client never throws", async () => {
		const tryWhoAmI: TryEnigmaWhoAmI = async () => {
			throw new Error("boom");
		};
		const env = await resolveSearchEnv(
			{ WEB_SPIDER_USE_ENIGMA: "1", TAVILY_API_KEY: "static" },
			{ tryWhoAmI, searchKeysDir: NO_LOCAL_KEYS_DIR },
		);
		expect(env).toEqual({ WEB_SPIDER_USE_ENIGMA: "1", TAVILY_API_KEY: "static" });
	});

	it("one backend's credential lookup failing does not block another's", async () => {
		const who = { name: "web-spider", backends: ["Brave", "Exa"] };
		const tryCredential: TryEnigmaCredential = async (backend) => {
			if (backend === "Brave") throw new Error("boom");
			return { accessToken: "e-key", extra: { envVarName: "EXA_API_KEY" } };
		};
		const env = await resolveSearchEnv(
			{ WEB_SPIDER_USE_ENIGMA: "1", BRAVE_SEARCH_API_KEY: "static-brave" },
			{ tryWhoAmI: async () => who, tryCredential, searchKeysDir: NO_LOCAL_KEYS_DIR },
		);
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
		await resolveSearchEnv(
			{ WEB_SPIDER_USE_ENIGMA: "1", ENIGMA_CLIENT_TOKEN: "web-spider-own-token" },
			{ tryWhoAmI, tryCredential, searchKeysDir: NO_LOCAL_KEYS_DIR },
		);
		expect(seenTokens.every((t) => t === "web-spider-own-token")).toBe(true);
	});
});
