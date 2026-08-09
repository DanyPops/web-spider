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
import { defineErrorMapping, isVehicleError, VehicleError, type VehicleFailureCategory } from "@danypops/vehicle-core";
import { FetchTransportError } from "@danypops/web-spider";
import { SessionNotFoundError, StaleSnapshotError } from "../session/session-service.ts";

const mapLegacyError = defineErrorMapping([
	{ errorClass: SessionNotFoundError, category: "not_found", code: "session-not-found" },
	{ errorClass: StaleSnapshotError, category: "conflict", code: "stale-snapshot" },
]);

function transportFailureCategory(error: FetchTransportError): VehicleFailureCategory {
	if (error.kind === "timeout") return "timeout";
	if (error.kind === "aborted") return "cancelled";
	return "unavailable";
}

/**
 * Exception-translation boundary between protocol-independent Web Spider
 * domain failures and Vehicle's wire contract. Only fixed, reviewed domain
 * fields are serialized; the native cause intentionally remains in-process.
 */
export async function withVehicleErrorParity<T>(run: () => T | Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isVehicleError(error)) throw error;
		if (error instanceof FetchTransportError) {
			throw new VehicleError(error.code, error.message, {
				category: transportFailureCategory(error),
				retryable: error.retryable,
				details: { kind: error.kind, diagnostic: error.diagnostic },
				cause: error,
			});
		}
		return mapLegacyError(() => {
			throw error;
		});
	}
}
