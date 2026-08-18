/**
 * Spawns the real shipped `cli.ts search-key` binary as a subprocess against a real temp XDG
 * state dir -- pure local filesystem operations, no daemon or network involved, so runCli()'s
 * in-process fakeDeps() (cli.test.ts's own convention) can't control where these commands read
 * or write: resolveWebSpiderPaths() resolves from the real process env / os.homedir() directly.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliToCompletion } from "@danypops/pi-process-harness";
import { migrateLegacyServiceEnvironment } from "../src/cli.ts";
import { loadEnigmaConfig } from "../src/search/enigma-config.ts";
import { createSearchKeyStore } from "../src/search/search-secrets.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

async function spawnCli(
	args: string[],
	env: Record<string, string>,
	opts: { stdin?: Blob } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return runCliToCompletion("bun", [CLI_PATH, ...args], {
		env,
		...(opts.stdin ? { stdin: opts.stdin } : {}),
	});
}

async function runCliProcess(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	return spawnCli(args, env);
}

function tempXdgEnv(dir: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", XDG_STATE_HOME: dir };
}

describe("web-spider search-key set (real subprocess)", () => {
	it("exits non-zero with usage when no engine is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "set"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: web-spider search-key set");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero for an engine name web-spider doesn't know", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "set", "bogus-engine"], {
				...tempXdgEnv(dir),
				WEB_SPIDER_SEARCH_KEY_VALUE: "x",
			});
			expect(code).not.toBe(0);
			expect(stderr).toContain('unknown search engine: "bogus-engine"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves a real key via WEB_SPIDER_SEARCH_KEY_VALUE, non-interactively", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stdout } = await runCliProcess(["search-key", "set", "brave"], {
				...tempXdgEnv(dir),
				WEB_SPIDER_SEARCH_KEY_VALUE: "real-brave-key",
			});
			expect(code).toBe(0);
			expect(stdout).toContain('Search key saved for "brave"');

			const stateFile = join(dir, "web-spider", "search-keys", "brave.json");
			expect(existsSync(stateFile)).toBe(true);
			const saved = JSON.parse(readFileSync(stateFile, "utf8"));
			expect(saved).toEqual({ accessToken: "real-brave-key" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message when no value is provided and stdin has nothing piped in", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await spawnCli(["search-key", "set", "brave"], tempXdgEnv(dir), { stdin: new Blob([""]) });
			expect(code).not.toBe(0);
			expect(stderr).toContain("no API key value provided");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("web-spider search-key add (real subprocess, BYOK key stacking)", () => {
	it("exits non-zero with usage when no engine is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "add"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: web-spider search-key add");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stacks a second key alongside one already set, without discarding it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			await runCliProcess(["search-key", "set", "tavily"], { ...tempXdgEnv(dir), WEB_SPIDER_SEARCH_KEY_VALUE: "key-one" });
			const { code, stdout } = await runCliProcess(["search-key", "add", "tavily"], {
				...tempXdgEnv(dir),
				WEB_SPIDER_SEARCH_KEY_VALUE: "key-two",
			});
			expect(code).toBe(0);
			expect(stdout).toContain('Search key added for "tavily"');
			expect(stdout).toContain("2 key(s)");

			const stateFile = join(dir, "web-spider", "search-keys", "tavily.json");
			const saved = JSON.parse(readFileSync(stateFile, "utf8"));
			expect(saved.accessToken).toBe("key-one"); // primary key unchanged
			expect(saved.keys).toEqual(["key-one", "key-two"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never prints either key value to stdout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			await runCliProcess(["search-key", "set", "brave"], { ...tempXdgEnv(dir), WEB_SPIDER_SEARCH_KEY_VALUE: "first-secret" });
			const { stdout } = await runCliProcess(["search-key", "add", "brave"], {
				...tempXdgEnv(dir),
				WEB_SPIDER_SEARCH_KEY_VALUE: "second-secret",
			});
			expect(stdout).not.toContain("first-secret");
			expect(stdout).not.toContain("second-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("web-spider search-key list (real subprocess)", () => {
	it("prints an empty array when nothing is stored yet", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stdout } = await runCliProcess(["search-key", "list"], tempXdgEnv(dir));
			expect(code).toBe(0);
			expect(JSON.parse(stdout)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists every stored engine's name, sorted, never the key itself", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			await runCliProcess(["search-key", "set", "tavily"], { ...tempXdgEnv(dir), WEB_SPIDER_SEARCH_KEY_VALUE: "should-never-be-printed" });
			await runCliProcess(["search-key", "set", "brave"], { ...tempXdgEnv(dir), WEB_SPIDER_SEARCH_KEY_VALUE: "also-secret" });

			const { stdout } = await runCliProcess(["search-key", "list"], tempXdgEnv(dir));
			expect(JSON.parse(stdout)).toEqual(["brave", "tavily"]);
			expect(stdout).not.toContain("should-never-be-printed");
			expect(stdout).not.toContain("also-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("web-spider search-key remove (real subprocess)", () => {
	it("deletes a stored key and reports success", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			await runCliProcess(["search-key", "set", "brave"], { ...tempXdgEnv(dir), WEB_SPIDER_SEARCH_KEY_VALUE: "brave-key" });
			const stateFile = join(dir, "web-spider", "search-keys", "brave.json");
			expect(existsSync(stateFile)).toBe(true);

			const { code, stdout } = await runCliProcess(["search-key", "remove", "brave"], tempXdgEnv(dir));
			expect(code).toBe(0);
			expect(stdout).toContain('Removed search key for "brave"');
			expect(existsSync(stateFile)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with a clear message for an engine with nothing stored", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "remove", "brave"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain('no search key stored for "brave"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exits non-zero with usage when no engine is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "remove"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("usage: web-spider search-key remove");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("legacy service environment migration", () => {
	it("moves provider keys and Enigma opt-in to local stores but never persists the Enigma token", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-legacy-env-"));
		try {
			const paths = {
				database: join(dir, "data", "web-spider.db"),
				token: join(dir, "state", "auth-token"),
				handle: join(dir, "runtime", "daemon.json"),
				systemdUnit: join(dir, "config", "web-spider.service"),
				metrics: join(dir, "data", "metrics.sqlite"),
			};
			migrateLegacyServiceEnvironment(
				"BRAVE_SEARCH_API_KEY=provider-secret WEB_SPIDER_USE_ENIGMA=1 ENIGMA_CLIENT_TOKEN=must-not-persist",
				paths,
			);
			expect(createSearchKeyStore(join(dir, "state", "search-keys"), "brave").load()).toBe("provider-secret");
			expect(loadEnigmaConfig(join(dir, "state", "enigma.json"))).toEqual({ useEnigma: true });
			const persisted = `${readFileSync(join(dir, "state", "search-keys", "brave.json"), "utf8")} ${readFileSync(join(dir, "state", "enigma.json"), "utf8")}`;
			expect(persisted).not.toContain("must-not-persist");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("web-spider enigma (real subprocess)", () => {
	it("persists only the non-secret opt-in with mode 0600", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-enigma-"));
		try {
			const enabled = await runCliProcess(["enigma", "enable"], tempXdgEnv(dir));
			expect(enabled.code).toBe(0);
			const configPath = join(dir, "web-spider", "enigma.json");
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ useEnigma: true });
			expect(Bun.file(configPath).size).toBeLessThan(100);
			expect(statSync(configPath).mode & 0o777).toBe(0o600);
			const status = await runCliProcess(["enigma", "status"], tempXdgEnv(dir));
			expect(status.stdout.trim()).toBe("enabled");
			const disabled = await runCliProcess(["enigma", "disable"], tempXdgEnv(dir));
			expect(disabled.code).toBe(0);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ useEnigma: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("web-spider search-key (real subprocess): unknown subcommand", () => {
	it("exits non-zero with usage for an unrecognized subcommand", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-key-"));
		try {
			const { code, stderr } = await runCliProcess(["search-key", "bogus"], tempXdgEnv(dir));
			expect(code).not.toBe(0);
			expect(stderr).toContain("Usage: web-spider");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
