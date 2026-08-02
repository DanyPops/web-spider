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
import type { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { createRetryingClient } from "@danypops/vehicle-client/daemon-client";
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
// so far (category.* today; see category-vehicle.ts). Same retry-once-on-
// stale-connection policy, same daemon, a different route/client shape.
// ---------------------------------------------------------------------------
type VehicleClientConnector = () => Promise<RemoteVehicleClient>;

let vehicleConnector: VehicleClientConnector = () => connectOrStartWebSpiderVehicleClient();
const retryingVehicleClient = createRetryingClient<RemoteVehicleClient>(() => vehicleConnector(), { label: "Web Spider (Vehicle)" });

const VEHICLE_PERMISSIONS = ["web-spider:read", "web-spider:write"];

export async function invokeWebSpiderVehicle<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
	return retryingVehicleClient.call((client) => client.invoke<T>(operation, 1, input, { permissions: VEHICLE_PERMISSIONS }));
}

export function setWebSpiderVehicleClientConnectorForTests(value: VehicleClientConnector): void {
	vehicleConnector = value;
	retryingVehicleClient.reset();
}

export function resetWebSpiderVehicleClientConnectorForTests(): void {
	vehicleConnector = () => connectOrStartWebSpiderVehicleClient();
	retryingVehicleClient.reset();
}
