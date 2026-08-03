/**
 * Wraps connectOrStartWebSpiderClient() with the retry-once-on-stale-
 * connection policy generalized into @danypops/vehicle-client's daemon-client
 * module (this file, papyrus's callService(), and lector's lectorClient()
 * were three of the four independent reimplementations that motivated it).
 * The daemon binds a new random port on every restart; a client resolved
 * once and cached for the rest of a Pi session would otherwise point at a
 * dead port after any later restart until the whole extension reloaded.
 * createRetryingClient() detects that on the failing call itself (not just
 * the first connection attempt), drops the stale cache entry, and retries
 * once against a freshly re-resolved client.
 */

import { createReconnectingVehicleClient, createRetryingClient } from "@danypops/vehicle-client/daemon-client";
import type { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { invokeVehicleOperation, type VehicleOperationInvocationResult } from "@danypops/vehicle-client-pi";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connectOrStartWebSpiderClient, connectOrStartWebSpiderVehicleClient, type WebSpiderClient } from "./daemon-client.js";

type ClientConnector = () => Promise<WebSpiderClient>;

let connector: ClientConnector = () => connectOrStartWebSpiderClient();
const retryingClient = createRetryingClient<WebSpiderClient>(() => connector(), { label: "Web Spider" });

export async function callWebSpider<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
	return retryingClient.call((client) => client.call<T>(operation, input));
}

export function setWebSpiderClientConnectorForTests(value: ClientConnector): void {
	connector = value;
	retryingClient.reset();
}

export function resetWebSpiderClientConnectorForTests(): void {
	connector = () => connectOrStartWebSpiderClient();
	retryingClient.reset();
}

// ---------------------------------------------------------------------------
// Vehicle-protocol path -- used by whichever tool operations have migrated
// so far (category.* today; see category-vehicle.ts). Same daemon, a
// different route/client shape, and a deliberately different retry policy
// per call: createReconnectingVehicleClient() (from @danypops/vehicle-client)
// is the same wrapper registerVehicleTools() itself uses -- manifest() is
// safely retried on a stale connection (read-only, idempotent), while
// invoke() is never transparently retried (Vehicle's own idempotency model
// -- safe/keyed/unsafe -- is real per-operation information this wire-level
// wrapper can't safely generalize over), only the stale connection itself is
// dropped so the *next* call reconnects. That is the correct call()/
// callOnce() split for a Vehicle operation -- by client method, not by
// operation name -- so there is nothing web-spider needs to reimplement here.
// ---------------------------------------------------------------------------
type VehicleClientConnector = () => Promise<RemoteVehicleClient>;

let vehicleConnector: VehicleClientConnector = () => connectOrStartWebSpiderVehicleClient();
let vehicleClient: VehicleClient = createReconnectingVehicleClient(() => vehicleConnector());

const VEHICLE_PERMISSIONS = ["web-spider:read", "web-spider:write"];

export function setWebSpiderVehicleClientConnectorForTests(value: VehicleClientConnector): void {
	vehicleConnector = value;
	vehicleClient = createReconnectingVehicleClient(() => vehicleConnector());
}

export function resetWebSpiderVehicleClientConnectorForTests(): void {
	vehicleConnector = () => connectOrStartWebSpiderVehicleClient();
	vehicleClient = createReconnectingVehicleClient(() => vehicleConnector());
}

/**
 * A consolidated multi-action tool (web_category today) dispatching one of
 * its own sub-actions through the same cross-cutting policy layer a
 * registerVehicleTools()-registered tool gets automatically -- activity
 * broadcasting, the local /safety "ask" gate, the server approval-required
 * retry dance, idempotency-key/correlationId derivation -- instead of a bare
 * client.invoke() call, which would forfeit all of the above. See
 * invokeVehicleOperation() in @danypops/vehicle-client-pi for what this adds.
 *
 * Fetches the manifest on every call rather than caching it: category.* are
 * low-frequency, user-driven actions (not a hot path), and a fresh manifest
 * fetch is one cheap extra round trip that also self-heals if the daemon's
 * own operation set ever changes between calls.
 */
export async function invokeWebSpiderVehicleOperation(
	operationName: string,
	input: Record<string, unknown>,
	call: {
		toolName: string;
		toolCallId: string;
		signal?: AbortSignal;
		onUpdate?: AgentToolUpdateCallback<VehicleOperationInvocationResult["details"]>;
		context: ExtensionContext;
	},
): Promise<VehicleOperationInvocationResult> {
	const manifest = await vehicleClient.manifest();
	const descriptor = manifest.operations.find((op) => op.name === operationName);
	if (!descriptor) throw new Error(`Web Spider Vehicle manifest has no operation named '${operationName}'`);
	return invokeVehicleOperation({
		client: vehicleClient,
		manifest,
		descriptor,
		toolName: call.toolName,
		toolCallId: call.toolCallId,
		input,
		context: call.context,
		signal: call.signal,
		onUpdate: call.onUpdate,
		options: { permissions: VEHICLE_PERMISSIONS },
	});
}
