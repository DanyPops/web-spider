/**
 * quotes projected as a real VehicleOperation -- the standalone resource-finder
 * op (see fetch/quotes-service.ts's own doc comment). Fetches an explicit URL
 * set (never discovers new ones) and returns ranked, verbatim BM25F quotes per
 * url -- effect: "open-world" (it performs real network fetches), same
 * reasoning as fetch/crawl.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { QuotesService } from "../fetch/quotes-service.ts";
import { optionalBoolean, optionalNumber, optionalStringArray, requireString } from "../service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 16_384, maxResponseBytes: 1_048_576 };

export function registerQuotesVehicleOperations(registry: VehicleRegistry, quotesService: QuotesService): void {
	const quotesOperation = defineVehicleOperation({
		name: "quotes",
		version: 1,
		description:
			"Fetches an explicit set of URLs (e.g. a prior search's results) and returns ranked, verbatim BM25F quotes per url as resource cards -- never an LLM-digested answer.",
		input: defineLooseObjectSchema(
			{
				query: { type: "string" },
				urls: { type: "array" },
				maxQuotesPerUrl: { type: "number" },
				maxQuotesTotal: { type: "number" },
				timeoutMs: { type: "number" },
				enhanced: { type: "boolean" },
				ignoreRobots: { type: "boolean" },
				sources: { type: "array" },
			},
			["query", "urls"],
		),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "open-world",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(quotesOperation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			return withVehicleErrorParity(() =>
				quotesService.quotes({
					query: requireString(input, "query"),
					urls: optionalStringArray(input, "urls") ?? [],
					maxQuotesPerUrl: optionalNumber(input, "maxQuotesPerUrl"),
					maxQuotesTotal: optionalNumber(input, "maxQuotesTotal"),
					timeoutMs: optionalNumber(input, "timeoutMs"),
					enhanced: optionalBoolean(input, "enhanced"),
					ignoreRobots: optionalBoolean(input, "ignoreRobots"),
					sources: optionalStringArray(input, "sources"),
				}),
			);
		}),
	);
}
