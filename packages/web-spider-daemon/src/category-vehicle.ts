/**
 * category.* projected as a real VehicleRegistry -- the first slice of
 * web-spider's own Vehicle protocol migration (walking skeleton). Wraps the
 * exact same CacheStore methods service.ts's own hand-rolled dispatcher
 * calls for these four operations; no behavior change, only a second real
 * transport (served alongside the existing /api/v1/ops route, not replacing
 * it yet) with standardized error taxonomy and effect classification.
 *
 * Deliberately scoped to category.* only: the remaining eleven operations
 * (fetch, crawl, search, the session actions, papyrus.ingest) either need
 * Vehicle Jobs (crawl, fetch with enhanced:true) or carry stateful session
 * semantics (session.act's snapshotVersion contract) that deserve their own
 * dedicated conversion pass, not a mechanical bulk port.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { CacheStore } from "./ports/cache-store.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 15_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 };

function requireString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

export function createCategoryVehicleRegistry(store: CacheStore): VehicleRegistry {
	const registry = new VehicleRegistry({
		name: "web-spider",
		version: "1.0.0",
		description: "Curated, agent/user-assignable relevance categories for cached pages.",
	});

	const define = (
		action: "assign" | "remove" | "rename" | "list",
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string }>,
		required: readonly string[],
		handler: (input: Record<string, unknown>) => unknown,
	): void => {
		const operation = defineVehicleOperation({
			name: `category.${action}`,
			version: 1,
			description,
			input: defineLooseObjectSchema(properties, required),
			output: passthroughVehicleSchema,
			permissions: ["web-spider:read", "web-spider:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => handler(context.input as Record<string, unknown>)),
		);
	};

	define(
		"assign",
		"Adds a category to a cached page (creating it if new; assigning a category the page already has is a harmless no-op).",
		"local-write",
		{ url: { type: "string" }, category: { type: "string" } },
		["url", "category"],
		(input) => store.assignCategory(requireString(input, "url"), requireString(input, "category")),
	);

	define(
		"remove",
		"Removes a category from a cached page (harmless no-op if it wasn't assigned).",
		"local-write",
		{ url: { type: "string" }, category: { type: "string" } },
		["url", "category"],
		(input) => {
			const url = requireString(input, "url");
			const category = requireString(input, "category");
			store.removeCategory(url, category);
			return { url, category, removed: true as const };
		},
	);

	define(
		"rename",
		"Renames a category everywhere it's used in one step. If newName already exists as a different category, the two merge instead of erroring.",
		"local-write",
		{ category: { type: "string" }, newName: { type: "string" } },
		["category", "newName"],
		(input) => store.renameCategory(requireString(input, "category"), requireString(input, "newName")),
	);

	define("list", "Lists every known category with how many pages use it.", "read", {}, [], () => store.listCategories());

	return registry;
}
