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
import { defineErrorMapping } from "@danypops/vehicle-core";
import { SessionNotFoundError, StaleSnapshotError } from "./session-service.ts";

export const withVehicleErrorParity = defineErrorMapping([
	{ errorClass: SessionNotFoundError, category: "not_found", code: "session-not-found" },
	{ errorClass: StaleSnapshotError, category: "conflict", code: "stale-snapshot" },
]);
