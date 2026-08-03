/**
 * Preserves /api/v1/ops's own error-to-status behavior for every operation
 * migrated onto the real Vehicle protocol. The legacy route's policy (see
 * service.ts's createApp): SessionNotFoundError -> 404, StaleSnapshotError
 * -> 409, everything else a handler throws (including domain validation
 * like "highlights format requires a query") -> 400.
 *
 * Without this, VehicleRegistry's own invoke() wraps any handler-thrown
 * error that isn't already a VehicleError into category:"internal" (HTTP
 * 500) -- regressing every one of those legacy-400 business rejections to
 * a 500, and losing its own specific message in the process (a
 * VehicleFailure sent over the wire never carries an error's `cause`).
 */
import { VehicleError } from "@danypops/vehicle-core";
import { SessionNotFoundError, StaleSnapshotError } from "./session-service.ts";

export async function withVehicleErrorParity<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof VehicleError) throw error;
		if (error instanceof SessionNotFoundError) {
			throw new VehicleError("session-not-found", error.message, { category: "not_found", cause: error });
		}
		if (error instanceof StaleSnapshotError) {
			throw new VehicleError("stale-snapshot", error.message, { category: "conflict", cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new VehicleError("operation-rejected", message, { category: "validation", cause: error });
	}
}
