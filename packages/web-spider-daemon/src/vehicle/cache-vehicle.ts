/**
 * cache.list/cache.search projected as real VehicleOperations -- the second
 * slice of web-spider's own Vehicle protocol migration. Wraps the exact same
 * CacheStore methods service.ts's own hand-rolled dispatcher calls for these
 * two operations; no behavior change, only a second real transport (served
 * alongside the existing /api/v1/ops route, not replacing it yet).
 *
 * Both are pure local reads (the daemon's own SQLite cache), same shape as
 * category.list -- effect: "read", idempotency: "safe".
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { CachedPageListFilter } from "../domain/page.ts";
import type { CacheStore } from "../ports/cache-store.ts";
import { withVehicleErrorParity } from "./vehicle-error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 15_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 };

function requireString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

export function registerCacheVehicleOperations(registry: VehicleRegistry, store: CacheStore): void {
	const listOperation = defineVehicleOperation({
		name: "cache.list",
		version: 1,
		description: "Lists cached pages, optionally filtered by grep/domain/tag/category/fetch-date range, sorted and paginated.",
		input: defineLooseObjectSchema(
			{
				grep: { type: "string" },
				domain: { type: "string" },
				tag: { type: "string" },
				category: { type: "string" },
				fetchedAfter: { type: "number" },
				fetchedBefore: { type: "number" },
				publishedAfter: { type: "string" },
				publishedBefore: { type: "string" },
				sortBy: { type: "string" },
				sortOrder: { type: "string" },
				offset: { type: "number" },
				limit: { type: "number" },
			},
			[],
		),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			listOperation,
			() => async (context) => withVehicleErrorParity(() => store.list(context.input as CachedPageListFilter)),
		),
	);

	const searchOperation = defineVehicleOperation({
		name: "cache.search",
		version: 1,
		description: "Full-text searches cached pages, returning matching chunks with context (not just a page listing).",
		input: defineLooseObjectSchema({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			searchOperation,
			() => async (context) =>
				withVehicleErrorParity(() => {
					const input = context.input as Record<string, unknown>;
					const limit = input.limit;
					return store.search(requireString(input, "query"), { topN: typeof limit === "number" ? limit : undefined });
				}),
		),
	);
}
