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
import { LAUNCH_PROVENANCE_ENV_VAR } from "@danypops/vehicle-server/daemon";
import { connectWebSpiderClient } from "../src/client.ts";
import { readDaemonHandle, resolveWebSpiderPaths } from "../src/state.ts";
import { VERSION } from "../src/version.ts";

/**
 * Deleted, not just left unset: spreading process.env below otherwise leaks whatever ambient
 * provenance the test runner ITSELF happens to be running under (e.g. a gate-runner daemon that
 * was itself auto-spawned) into the spawned subprocess-under-test, defeating the "unknown"
 * assertion below for a reason having nothing to do with the daemon code being tested.
 */
function isolatedSpawnEnv(overrides: Record<string, string>): Record<string, string | undefined> {
	const env = { ...process.env, ...overrides };
	delete env[LAUNCH_PROVENANCE_ENV_VAR];
	return env;
}

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// The daemon's own stop() now always awaits a real (JSON read-modify-write, atomic-rename)
// lifecycle-log write *before* removing the handle file (see vehicle-server daemon.ts) -- a few
// extra ms under normal conditions, but this file spawns several real `bun` subprocesses across
// its own tests, and disk/process-scheduling contention from that stacks up. 10s (not the
// previous 5s) is comfortable headroom for a real subprocess round-trip, not a sign anything here
// is actually slow in the steady state (measured consistently under 500ms in isolation).
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
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
		const env = isolatedSpawnEnv({
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
		});
		const paths = resolveWebSpiderPaths({ env, home: root, uid: 1000 });

		const proc = Bun.spawn(["bun", CLI_PATH, "serve"], { env, stdout: "pipe", stderr: "pipe" });
		try {
			await waitFor(() => readDaemonHandle(paths) !== null);

			const client = connectWebSpiderClient(paths);
			const health = await client.health();
			expect(health.ok).toBe(true);
			// Regression: this used to be a hand-hardcoded "0.1.0" that never
			// moved past the package's first release.
			expect(health.version).toBe(VERSION);
			expect(health.version).not.toBe("0.1.0");

			const operations = await client.operations();
			expect(operations).toContain("cache.list");
			expect(operations).toContain("cache.search");
			expect(operations).toContain("search");

			const listing = await client.call("cache.list", {});
			expect(listing).toEqual({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] });

			expect(await client.ready()).toBe(true);
		} finally {
			proc.kill("SIGTERM");
			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();
			// Regression: the checkpoint/optimize maintenance timers used to
			// swallow failures with an empty catch block and log nothing at all,
			// ever -- confirm the daemon now emits real structured events.
			// "msg" (not "event") is @danypops/vehicle-server's pino-backed field
			// name for the log message text -- see log.test.ts.
			expect(stderr).toContain('"msg":"listening"');
			expect(stderr).toContain('"component":"web-spider-daemon"');
			expect(exitCode).toBe(0);
			await waitFor(() => readDaemonHandle(paths) === null);
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	test("daemon.diagnose reports this instance's own identity, and a restarted daemon sees the prior instance's real history", async () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-e2e-diagnose-"));
		const env = isolatedSpawnEnv({
			HOME: root,
			XDG_DATA_HOME: join(root, "data"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_RUNTIME_DIR: join(root, "run"),
			XDG_CONFIG_HOME: join(root, "config"),
			WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache-here.json"),
		});
		const paths = resolveWebSpiderPaths({ env, home: root, uid: 1000 });

		const first = Bun.spawn(["bun", CLI_PATH, "serve"], { env, stdout: "pipe", stderr: "pipe" });
		try {
			await waitFor(() => readDaemonHandle(paths) !== null);
			const client = connectWebSpiderClient(paths);
			const diagnosis = (await client.call("daemon.diagnose", {})) as {
				instanceId: string;
				pid: number;
				provenance: string;
				history: Array<{ instanceId: string; type: string }>;
			};
			expect(diagnosis.instanceId).toEqual(expect.any(String));
			expect(diagnosis.pid).toBe(first.pid);
			expect(diagnosis.provenance).toBe("unknown");
			// First ever instance under this isolated root -- no prior history to report yet.
			expect(diagnosis.history.map((event) => event.type)).toEqual(["started"]);
			const firstInstanceId = diagnosis.instanceId;

			first.kill("SIGTERM");
			await first.exited;
			await waitFor(() => readDaemonHandle(paths) === null);

			const second = Bun.spawn(["bun", CLI_PATH, "serve"], { env, stdout: "pipe", stderr: "pipe" });
			try {
				await waitFor(() => readDaemonHandle(paths) !== null);
				const secondClient = connectWebSpiderClient(paths);
				const secondDiagnosis = (await secondClient.call("daemon.diagnose", {})) as {
					instanceId: string;
					history: Array<{ instanceId: string; type: string; reason?: string }>;
				};
				expect(secondDiagnosis.instanceId).not.toBe(firstInstanceId);
				// Real restart history survived the restart -- the whole point of a *persistent* lifecycle log.
				expect(secondDiagnosis.history).toEqual([
					expect.objectContaining({ instanceId: firstInstanceId, type: "started" }),
					expect.objectContaining({ instanceId: firstInstanceId, type: "stopped", reason: "SIGTERM" }),
					expect.objectContaining({ instanceId: secondDiagnosis.instanceId, type: "started" }),
				]);
			} finally {
				second.kill("SIGTERM");
				await second.exited;
				await waitFor(() => readDaemonHandle(paths) === null);
			}
		} finally {
			if (!first.killed) first.kill("SIGTERM");
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

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
