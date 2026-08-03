/**
 * Spawns the real shipped `cli.ts search-key` binary as a subprocess against a real temp XDG
 * state dir -- pure local filesystem operations, no daemon or network involved, so runCli()'s
 * in-process fakeDeps() (cli.test.ts's own convention) can't control where these commands read
 * or write: resolveWebSpiderPaths() resolves from the real process env / os.homedir() directly.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Bun.spawn()'s piped stdout/stderr intermittently comes back empty when run
 * inside `bun test`, even though the child process ran and exited normally --
 * a confirmed, still-open upstream bug (https://github.com/oven-sh/bun/issues/24690),
 * not anything in this file or cli.ts. Every real invocation of this CLI writes
 * to at least one of stdout/stderr, so both empty despite a real exit is exactly
 * that bug's signature -- retry (bounded) rather than fail on a lost pipe read.
 */
const MAX_SPAWN_ATTEMPTS = 3;

async function spawnCli(
	args: string[],
	env: Record<string, string>,
	opts: { stdin?: Blob } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	let result!: { code: number; stdout: string; stderr: string };
	for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
		const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
			env,
			stdout: "pipe",
			stderr: "pipe",
			...(opts.stdin ? { stdin: opts.stdin } : {}),
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		result = { code, stdout, stderr };
		if (stdout.length > 0 || stderr.length > 0 || attempt === MAX_SPAWN_ATTEMPTS) break;
	}
	return result;
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
