/**
 * search/search.usage projected as real VehicleOperations -- the third slice
 * of web-spider's own Vehicle protocol migration. `search` reaches a
 * third-party web-search provider chosen by whichever API key is
 * configured (a paid, uncontrolled external system) -- effect: "open-world",
 * distinct from category.* / cache.*'s "read"/"local-write" (the daemon's own
 * bounded local state). `search.usage` is a pure local read of the daemon's
 * own usage journal.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { SearchEngine } from "@danypops/web-spider";
import { SEARCH_ENGINE_USAGE_LIST_DEFAULT_LIMIT } from "../constants.ts";
import { testProviderKeys, type WebSearchService } from "../search/search-service.ts";
import type { SearchUsageJournal } from "../search/search-usage-journal.ts";
import { optionalNumber, optionalString, searchInput } from "../service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 15_000, maxTimeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 262_144 };

export function registerSearchVehicleOperations(
	registry: VehicleRegistry,
	webSearch: WebSearchService,
	searchUsage: SearchUsageJournal,
	loadSearchKeys: (engine: string) => string[],
): void {
	const searchOperation = defineVehicleOperation({
		name: "search",
		version: 1,
		description:
			"Searches the web via whichever provider is configured (auto-detected from available API keys, or forced via searchEngine).",
		input: defineLooseObjectSchema(
			{
				query: { type: "string" },
				numResults: { type: "number" },
				timeRange: { type: "string", enum: ["day", "week", "month", "year"] },
				topic: { type: "string", enum: ["news", "general"] },
				searchEngine: { type: "string" },
				siteFilter: { type: "string" },
				wantFullContent: { type: "boolean" },
			},
			["query"],
		),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "open-world",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			searchOperation,
			() => async (context) => withVehicleErrorParity(() => webSearch.search(searchInput(context.input as Record<string, unknown>))),
		),
	);

	const usageOperation = defineVehicleOperation({
		name: "search.usage",
		version: 1,
		description: "Lists the daemon's own recent web-search provider usage (credits/cost/rate-limit headers), newest first.",
		input: defineLooseObjectSchema({ engine: { type: "string" }, limit: { type: "number" } }, []),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(usageOperation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			return {
				entries: searchUsage.recent({
					engine: optionalString(input, "engine"),
					limit: optionalNumber(input, "limit") ?? SEARCH_ENGINE_USAGE_LIST_DEFAULT_LIMIT,
				}),
			};
		}),
	);

	const testKeysOperation = defineVehicleOperation({
		name: "search.testKeys",
		version: 1,
		description:
			"Live-tests every locally stored BYOK key for one search provider with a minimal query, reporting each key's status (valid/rate-limited/invalid/error) by its stored position -- never the raw key itself.",
		input: defineLooseObjectSchema({ engine: { type: "string" } }, ["engine"]),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "open-world",
		idempotency: { mode: "safe" },
		limits: { ...LIMITS, defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000 },
	});
	registry.register(
		OWNER,
		bindVehicleOperation(testKeysOperation, () => async (context) => {
			const input = context.input as Record<string, unknown>;
			const engine = input.engine as string;
			const keys = loadSearchKeys(engine);
			return withVehicleErrorParity(async () => ({ engine, results: await testProviderKeys(engine as SearchEngine, keys) }));
		}),
	);
}
