/**
 * papyrus.ingest projected as a real VehicleOperation -- the fourth slice of
 * web-spider's own Vehicle protocol migration. A real write to a peer
 * daemon (Papyrus), not the caller's own local state -- effect:
 * "external-write". No dedup by url: calling this twice with the same
 * input creates two separate Papyrus Docs, so idempotency is "unsafe".
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { PapyrusIngestService } from "./papyrus-ingest-service.ts";
import { papyrusIngestInput } from "./service.ts";
import { withVehicleErrorParity } from "./vehicle-error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 15_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 65_536 };

export function registerPapyrusVehicleOperations(registry: VehicleRegistry, papyrusIngest: PapyrusIngestService): void {
	const operation = defineVehicleOperation({
		name: "papyrus.ingest",
		version: 1,
		description:
			"Ingests a fetched page or a search result batch into Papyrus (the context mesh) as Doc artifact(s). Explicit opt-in only, never automatic.",
		input: defineLooseObjectSchema(
			{
				kind: { type: "string", enum: ["pages", "search"] },
				urls: { type: "array" },
				query: { type: "string" },
				engine: { type: "string" },
				results: { type: "array" },
				relatesTo: { type: "string" },
			},
			["kind"],
		),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read", "web-spider:write"],
		effect: "external-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			operation,
			() => async (context) =>
				withVehicleErrorParity(() => papyrusIngest.ingest(papyrusIngestInput(context.input as Record<string, unknown>))),
		),
	);
}
