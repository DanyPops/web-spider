import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonIdentity } from "@danypops/vehicle-server/daemon-lifecycle";
import { createWebSpiderLifecycleLog, resolveCurrentIdentityOrWait, resolveDaemonLifecycleLogPath } from "../src/daemon-lifecycle.ts";

describe("resolveDaemonLifecycleLogPath", () => {
	it("is a sibling of the auth token file, under this daemon's own persistent state directory -- not the ephemeral runtime-dir handle", () => {
		const path = resolveDaemonLifecycleLogPath({
			database: "/x/db",
			token: "/home/u/.local/state/web-spider/auth-token",
			handle: "/x/h",
			systemdUnit: "/x/s",
		});
		expect(path).toBe("/home/u/.local/state/web-spider/lifecycle.json");
	});
});

describe("resolveCurrentIdentityOrWait", () => {
	// Regression guard for a real race, not a hypothetical: vehicle-server's own startDaemon()
	// writes the daemon handle file *before* its own onListen callback fires (a few JS event-loop
	// ticks and one more awaited file write apart) -- a client that polls the handle file (this
	// daemon's own connectWithPolicy, a test, or any other real client) can observe "the daemon is
	// up" and call daemon.diagnose before this daemon's own onListen has populated its identity ref.
	// Reproduced live: an 8-run stress test of the real end-to-end daemon.test.ts hit this exact
	// race twice.
	it("returns immediately once identity becomes available, without waiting out the full timeout", async () => {
		const identity: DaemonIdentity = { instanceId: "i1", pid: 1, startedAt: "2026-01-01T00:00:00.000Z", provenance: "unknown" };
		let current: DaemonIdentity | undefined;
		const sleeps: number[] = [];
		const promise = resolveCurrentIdentityOrWait(() => current, {
			timeoutMs: 10_000,
			pollIntervalMs: 5,
			sleep: async (ms) => {
				sleeps.push(ms);
				if (sleeps.length === 2) current = identity;
			},
		});
		expect(await promise).toEqual(identity);
		expect(sleeps.length).toBeLessThan(5);
	});

	it("fails with a clear, actionable error once the bounded timeout is exhausted, rather than waiting forever", async () => {
		let elapsed = 0;
		await expect(
			resolveCurrentIdentityOrWait(() => undefined, {
				timeoutMs: 100,
				pollIntervalMs: 10,
				now: () => elapsed,
				sleep: async (ms) => {
					elapsed += ms;
				},
			}),
		).rejects.toThrow(/not ready/);
	});
});

describe("createWebSpiderLifecycleLog", () => {
	it("records and reads back a real event through a real file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-lifecycle-"));
		try {
			const log = createWebSpiderLifecycleLog(join(dir, "lifecycle.json"));
			await log.record({ instanceId: "instance-1", pid: 1234, type: "started", provenance: "unknown" });
			const recent = await log.recent();
			expect(recent).toHaveLength(1);
			expect(recent[0]).toMatchObject({ instanceId: "instance-1", pid: 1234, type: "started", provenance: "unknown" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
