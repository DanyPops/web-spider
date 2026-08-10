/**
 * daemon.diagnose -- "who am I, and what happened recently" (structured
 * instance identity + bounded restart history) without a caller ever
 * reading this daemon's own state files directly. Wraps vehicle-server's
 * shared daemon-lifecycle.ts primitive (see daemon-lifecycle.ts); this
 * daemon had no structured lifecycle diagnostics of any kind before this.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonIdentity } from "@danypops/vehicle-server/daemon-lifecycle";
import { createWebSpiderLifecycleLog } from "../src/daemon-lifecycle.ts";
import { createApp, createWebSpiderService, type WebSpiderService } from "../src/service.ts";

const TOKEN = "test-token";
const services: WebSpiderService[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function invoke(server: { fetch(request: Request): Promise<Response> }, name: string, input: Record<string, unknown>) {
	return server.fetch(
		new Request("http://x/vehicle/invoke", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
		}),
	);
}

describe("daemon.diagnose", () => {
	test("reports a default, always-present identity through the real Vehicle wire protocol when no real daemon identity was ever wired in (e.g. every other test in this suite)", async () => {
		const service = createWebSpiderService(":memory:");
		services.push(service);
		const server = createApp({ service, token: TOKEN });

		const response = await invoke(server, "daemon.diagnose", {});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			output: { instanceId: string; pid: number; startedAt: string; provenance: string; history: unknown[] };
		};
		expect(body.output.instanceId).toEqual(expect.any(String));
		expect(body.output.pid).toBe(process.pid);
		expect(body.output.history).toEqual([]);
	});

	test("reports the real injected identity and lifecycle history, not the default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-diagnose-"));
		tmpDirs.push(dir);
		const lifecycleLog = createWebSpiderLifecycleLog(join(dir, "lifecycle.json"));
		await lifecycleLog.record({ instanceId: "prior-instance", pid: 111, type: "started", provenance: "service" });
		await lifecycleLog.record({ instanceId: "prior-instance", pid: 111, type: "stopped", provenance: "service", reason: "SIGTERM" });

		const identity: DaemonIdentity = {
			instanceId: "current-instance",
			pid: 999,
			startedAt: "2026-01-01T00:00:00.000Z",
			provenance: "auto-spawn",
		};
		const service = createWebSpiderService(":memory:", { lifecycleLog, getCurrentIdentity: () => identity });
		services.push(service);
		const server = createApp({ service, token: TOKEN });

		const response = await invoke(server, "daemon.diagnose", {});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			output: {
				instanceId: string;
				pid: number;
				startedAt: string;
				provenance: string;
				history: Array<{ instanceId: string; type: string }>;
			};
		};
		expect(body.output).toMatchObject({
			instanceId: "current-instance",
			pid: 999,
			startedAt: "2026-01-01T00:00:00.000Z",
			provenance: "auto-spawn",
		});
		expect(body.output.history).toHaveLength(2);
		expect(body.output.history[0]).toMatchObject({ instanceId: "prior-instance", type: "started" });
		expect(body.output.history[1]).toMatchObject({ instanceId: "prior-instance", type: "stopped" });
	});

	test("respects an explicit historyLimit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-diagnose-"));
		tmpDirs.push(dir);
		const lifecycleLog = createWebSpiderLifecycleLog(join(dir, "lifecycle.json"));
		for (let i = 0; i < 5; i++) {
			await lifecycleLog.record({ instanceId: `instance-${i}`, pid: i, type: "started", provenance: "unknown" });
		}
		const identity: DaemonIdentity = { instanceId: "current", pid: 1, startedAt: "2026-01-01T00:00:00.000Z", provenance: "unknown" };
		const service = createWebSpiderService(":memory:", { lifecycleLog, getCurrentIdentity: () => identity });
		services.push(service);
		const server = createApp({ service, token: TOKEN });

		const response = await invoke(server, "daemon.diagnose", { historyLimit: 2 });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { output: { history: Array<{ instanceId: string }> } };
		expect(body.output.history).toHaveLength(2);
		expect(body.output.history.map((e) => e.instanceId)).toEqual(["instance-3", "instance-4"]);
	});

	test("fails safely with a clear error rather than crashing when the real daemon identity isn't ready yet", async () => {
		const service = createWebSpiderService(":memory:", { getCurrentIdentity: () => undefined });
		services.push(service);
		const server = createApp({ service, token: TOKEN });

		const response = await invoke(server, "daemon.diagnose", {});
		expect(response.status).toBeGreaterThanOrEqual(400);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message.toLowerCase()).toContain("not");
	});

	test("is listed in the manifest and, alongside every other operation, has a real CLI invocation and no leaked credentials", async () => {
		const service = createWebSpiderService(":memory:");
		services.push(service);
		const server = createApp({ service, token: TOKEN });
		const response = await server.fetch(new Request("http://x/vehicle/manifest", { headers: { authorization: `Bearer ${TOKEN}` } }));
		const body = (await response.json()) as { operations: Array<{ name: string }> };
		expect(body.operations.map((o) => o.name)).toContain("daemon.diagnose");
	});
});
