/**
 * The daemon binds a new random port on every restart. A client resolved once
 * and cached for the rest of a Pi session would otherwise point at a dead
 * port after any later restart -- callWebSpider() must detect that on the
 * failing call itself (not just the first connection attempt) and retry once
 * against a freshly re-resolved client. Mirrors lector-client.test.ts's
 * "recovers from a stale cached connection" coverage for the same bug shape.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectOrStartWebSpiderClient, readDaemonHandle, resolveWebSpiderPaths, type WebSpiderClient } from "../src/daemon-client.js";
import { callWebSpider, resetWebSpiderClientConnectorForTests, setWebSpiderClientConnectorForTests } from "../src/retrying-client.js";

afterEach(() => {
	resetWebSpiderClientConnectorForTests();
});

function tempEnv(prefix: string) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const env = {
		...(process.env as Record<string, string>),
		HOME: root,
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "run"),
		WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache-here.json"),
	};
	return { root, env, paths: resolveWebSpiderPaths({ env, home: root, uid: 1000 }) };
}

function fakeConnectionRefused(): WebSpiderClient {
	return {
		call: () => {
			throw new TypeError("fetch failed");
		},
	} as unknown as WebSpiderClient;
}

describe("callWebSpider recovers from a stale cached connection", () => {
	it("reconnects and retries once when the cached client's connection is stale, succeeding transparently", async () => {
		const { root, env, paths } = tempEnv("pi-web-spider-retrying-client-");
		let connectorCalls = 0;
		setWebSpiderClientConnectorForTests(() => {
			connectorCalls++;
			return connectorCalls === 1 ? Promise.resolve(fakeConnectionRefused()) : connectOrStartWebSpiderClient(paths, { env });
		});

		try {
			const result = await callWebSpider<{ total: number }>("cache.list", {});
			expect(result).toMatchObject({ total: 0 });
			expect(connectorCalls).toBe(2);
		} finally {
			const handle = readDaemonHandle(paths);
			if (handle) {
				try {
					process.kill(handle.pid, "SIGTERM");
				} catch {
					/* already gone */
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("gives up after one retry if the connection stays stale, rather than retrying forever", async () => {
		let connectorCalls = 0;
		setWebSpiderClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(fakeConnectionRefused());
		});

		await expect(callWebSpider("cache.list", {})).rejects.toThrow(TypeError);
		expect(connectorCalls).toBe(2);
	});

	it("does not retry a genuine operation-level error -- fails immediately rather than masking it", async () => {
		let connectorCalls = 0;
		const domainErrorClient = {
			call: () => {
				throw new Error("highlights format requires a query");
			},
		} as unknown as WebSpiderClient;
		setWebSpiderClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(domainErrorClient);
		});

		await expect(callWebSpider("fetch", {})).rejects.toThrow(/highlights format requires a query/);
		expect(connectorCalls).toBe(1);
	});

	it("does not re-resolve the connector on every call while the cached client stays healthy", async () => {
		let connectorCalls = 0;
		const healthyClient = {
			call: async () => ({ ok: true }),
		} as unknown as WebSpiderClient;
		setWebSpiderClientConnectorForTests(() => {
			connectorCalls++;
			return Promise.resolve(healthyClient);
		});

		await callWebSpider("cache.list", {});
		await callWebSpider("cache.list", {});
		expect(connectorCalls).toBe(1);
	});
});
