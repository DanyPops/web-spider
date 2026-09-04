/** Projects ordinary quote extraction and explicit robots-policy bypass as separate operations. */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { QuotesService } from "../fetch/quotes-service.ts";
import { optionalNumber, optionalStringArray, requireString } from "../service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 16_384, maxResponseBytes: 1_048_576 };
const PROPERTIES = {
	query: { type: "string" },
	urls: { type: "array" },
	maxQuotesPerUrl: { type: "number" },
	maxQuotesTotal: { type: "number" },
	timeoutMs: { type: "number" },
	enhanced: { type: "boolean" },
	sources: { type: "array" },
	maxCacheAgeMs: { type: "number" },
} as const;

export function registerQuotesVehicleOperations(registry: VehicleRegistry, quotesService: QuotesService): void {
	for (const bypassRobots of [false, true]) {
		const operation = defineVehicleOperation({
			name: bypassRobots ? "quotes.ignoreRobots" : "quotes",
			version: 1,
			description: bypassRobots
				? "Extracts quotes from explicit URLs while bypassing robots.txt for this approved request."
				: "Extracts ranked, verbatim quotes from an explicit bounded URL set.",
			input: defineLooseObjectSchema(PROPERTIES, ["query", "urls"]),
			output: passthroughVehicleSchema,
			permissions: ["web-spider:read"],
			effect: "open-world",
			requiresApproval: bypassRobots,
			idempotency: { mode: "safe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => {
				const input = context.input as Record<string, unknown>;
				return withVehicleErrorParity(() =>
					quotesService.quotes({
						query: requireString(input, "query"),
						urls: optionalStringArray(input, "urls") ?? [],
						maxQuotesPerUrl: optionalNumber(input, "maxQuotesPerUrl"),
						maxQuotesTotal: optionalNumber(input, "maxQuotesTotal"),
						timeoutMs: optionalNumber(input, "timeoutMs"),
						enhanced: input.enhanced === true,
						ignoreRobots: bypassRobots,
						sources: optionalStringArray(input, "sources"),
						maxCacheAgeMs: optionalNumber(input, "maxCacheAgeMs"),
					}),
				);
			}),
		);
	}
}
