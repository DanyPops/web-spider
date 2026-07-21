/**
 * End-to-end walking-skeleton proof: spawn the real CLI's `serve` command in
 * a subprocess with an isolated XDG environment, connect through the typed
 * client exactly as a real consumer would, call one real operation, then
 * shut the daemon down cleanly and verify the handle is removed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWebSpiderClient } from "../src/client.ts";
import { readDaemonHandle, resolveWebSpiderPaths } from "../src/state.ts";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition was not met within timeout");
}

describe("web-spider daemon — walking skeleton end-to-end", () => {
	test("serve → authenticate → one real operation → clean shutdown", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-e2e-"));
		const env = {
			...process.env,
			// HOME is overridden too, not just the XDG_* vars: resolveLegacyCachePath()
			// falls back to the real home directory (os.homedir() honors $HOME on
			// POSIX) when WEB_SPIDER_CACHE_PATH is unset. Without this, a spawned
			// daemon would read — and rename — the operator's real
			// ~/.cache/web-spider/pages.json as a one-time "legacy import" side
			// effect. Both overrides are kept for defense in depth.
			HOME: root,
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "run"),
			XDG_CONFIG_HOME: join(root, "config"),
			WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache-here.json"),
		};
		const paths = resolveWebSpiderPaths({ env, home: root, uid: 1000 });

		const proc = Bun.spawn(["bun", CLI_PATH, "serve"], { env, stdout: "pipe", stderr: "pipe" });
		try {
			await waitFor(() => readDaemonHandle(paths) !== null);

			const client = connectWebSpiderClient(paths);
			const health = await client.health();
			expect(health.ok).toBe(true);

			const operations = await client.operations();
			expect(operations).toContain("cache.list");

			const listing = await client.call("cache.list", {});
			expect(listing).toEqual({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] });

			expect(await client.ready()).toBe(true);
		} finally {
			proc.kill("SIGTERM");
			await proc.exited;
			await waitFor(() => readDaemonHandle(paths) === null);
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	test("connectWebSpiderClient fails closed with an actionable message when no daemon is running", () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-no-daemon-"));
		try {
			const paths = resolveWebSpiderPaths({ env: { XDG_RUNTIME_DIR: join(root, "run") }, home: root, uid: 1000 });
			expect(() => connectWebSpiderClient(paths)).toThrow(/daemon is not running/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
