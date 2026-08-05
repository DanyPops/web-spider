/**
 * invokeWebSpiderVehicleOperation() must apply the same call()/callOnce()
 * split by client method that @danypops/vehicle-client's own
 * createReconnectingVehicleClient() documents: manifest() self-heals
 * transparently on a stale connection (read-only, idempotent -- safe to
 * retry the whole call), while invoke() never transparently retries the
 * failed call itself (a mutating operation could otherwise be double-run on
 * the daemon after a transport failure) -- it only drops the stale
 * connection so the *next* call reconnects. Mirrors retrying-client.test.ts's
 * coverage for the legacy /api/v1/ops path, for the Vehicle-protocol path.
 */

import type { VehicleClient, VehicleManifest, VehicleManifestOperation } from "@danypops/vehicle-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	invokeWebSpiderVehicleOperation,
	resetWebSpiderVehicleClientConnectorForTests,
	setWebSpiderVehicleClientConnectorForTests,
} from "../src/retrying-client.js";

afterEach(() => {
	resetWebSpiderVehicleClientConnectorForTests();
});

/** Same fake ExtensionContext shape vehicle-client-pi's own tests build inline for calling invokeVehicleOperation() with no registered Pi tool at all. */
function fakeContext() {
	return { sessionManager: { getSessionId: () => "session-1" }, hasUI: false } as never;
}

const CATEGORY_ASSIGN_DESCRIPTOR: VehicleManifestOperation = {
	name: "category.assign",
	version: 1,
	description: "test double",
	inputSchema: {},
	outputSchema: {},
	permissions: ["web-spider:write"],
	effect: "local-write",
	idempotency: { mode: "safe" },
	streaming: false,
	longRunning: false,
	limits: { defaultTimeoutMs: 5000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536 },
	errors: [],
	available: true,
};

function fakeManifest(): VehicleManifest {
	return { name: "web-spider", version: "test", description: "test double", operations: [CATEGORY_ASSIGN_DESCRIPTOR] };
}

function fakeConnectionRefusedClient(): VehicleClient {
	return {
		manifest: () => {
			throw new TypeError("fetch failed");
		},
		invoke: () => {
			throw new TypeError("fetch failed");
		},
		close: async () => {},
	};
}

describe("invokeWebSpiderVehicleOperation: manifest() self-heals, invoke() never double-runs", () => {
	it("manifest() retries once and succeeds transparently on a stale connection", async () => {
		let connectorCalls = 0;
		let invokeCalls = 0;
		setWebSpiderVehicleClientConnectorForTests(async () => {
			connectorCalls++;
			if (connectorCalls === 1) return fakeConnectionRefusedClient();
			return {
				manifest: async () => fakeManifest(),
				invoke: async () => {
					invokeCalls++;
					return { url: "https://example.com", category: "Code", categoryId: 1 };
				},
				close: async () => {},
			};
		});

		const result = await invokeWebSpiderVehicleOperation(
			"category.assign",
			{ url: "https://example.com", category: "Code" },
			{ toolName: "web_category", toolCallId: "call-1", context: fakeContext() },
		);

		expect(result.details.output).toMatchObject({ category: "Code" });
		expect(connectorCalls).toBe(2);
		expect(invokeCalls).toBe(1);
	});

	it("does not retry invoke() itself on a stale connection -- fails once rather than risking a duplicate side effect", async () => {
		let connectorCalls = 0;
		let invokeCalls = 0;
		setWebSpiderVehicleClientConnectorForTests(async () => {
			connectorCalls++;
			const staleConnection = connectorCalls === 1;
			return {
				manifest: async () => fakeManifest(),
				invoke: async () => {
					invokeCalls++;
					if (staleConnection) throw new TypeError("fetch failed");
					return { url: "https://example.com", category: "Code", categoryId: 1 };
				},
				close: async () => {},
			};
		});

		await expect(
			invokeWebSpiderVehicleOperation(
				"category.assign",
				{ url: "https://example.com", category: "Code" },
				{ toolName: "web_category", toolCallId: "call-2", context: fakeContext() },
			),
		).rejects.toThrow(/fetch failed/);
		// invoke() itself is never re-run after its own failure...
		expect(invokeCalls).toBe(1);

		// ...but the stale connection was dropped, so the *next* call reconnects and succeeds.
		const result = await invokeWebSpiderVehicleOperation(
			"category.assign",
			{ url: "https://example.com", category: "Code" },
			{ toolName: "web_category", toolCallId: "call-3", context: fakeContext() },
		);
		expect(result.details.output).toMatchObject({ category: "Code" });
		expect(connectorCalls).toBe(2);
	});
});
