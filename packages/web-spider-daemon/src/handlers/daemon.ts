/**
 * daemon.diagnose projected as a real VehicleOperation -- "who am I, and
 * what happened recently" without a caller reading this daemon's own state
 * files directly. Wraps vehicle-server's shared diagnoseDaemon() primitive
 * (see daemon-lifecycle.ts) the same way handlers/category.ts wraps
 * CacheStore: no bespoke per-daemon reimplementation, one more slice
 * registered onto the shared VehicleRegistry service.ts already owns.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { type DaemonIdentity, type DaemonLifecycleLog, diagnoseDaemon } from "@danypops/vehicle-server/daemon-lifecycle";
import { resolveCurrentIdentityOrWait } from "../daemon-lifecycle.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 15_000, maxRequestBytes: 4_096, maxResponseBytes: 65_536 };

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" ? value : undefined;
}

export function registerDaemonVehicleOperations(
	registry: VehicleRegistry,
	lifecycleLog: DaemonLifecycleLog,
	getCurrentIdentity: () => DaemonIdentity | undefined,
): void {
	const operation = defineVehicleOperation({
		name: "daemon.diagnose",
		version: 1,
		description:
			"Reports this daemon's own current instance identity (instanceId/pid/startedAt/provenance) plus its recent restart history (started/already_running/stopped/crashed events, bounded), so a caller can tell whether the daemon is flapping without reading its state files directly.",
		input: defineLooseObjectSchema({ historyLimit: { type: "number" } }, []),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(operation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			return withVehicleErrorParity(async () => {
				// See resolveCurrentIdentityOrWait's own doc comment: a real, narrow race, not a
				// hypothetical -- the daemon handle a real client polls for becomes visible before
				// this daemon's own onListen populates getCurrentIdentity().
				const current = await resolveCurrentIdentityOrWait(getCurrentIdentity);
				return diagnoseDaemon({ lifecycleLog, current, historyLimit: optionalNumber(input, "historyLimit") });
			});
		}),
	);
}
