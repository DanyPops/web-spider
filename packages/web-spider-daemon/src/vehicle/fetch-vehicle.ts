/**
 * fetch/crawl projected as real VehicleOperations -- the fifth slice of
 * web-spider's own Vehicle protocol migration. Both fetch arbitrary
 * external content nobody vetted -- effect: "open-world", same reasoning
 * as search. Re-fetching/re-crawling the same URL upserts the same cached
 * row rather than creating a duplicate, so idempotency is "safe".
 *
 * Kept as plain synchronous operations for this slice, not Vehicle Jobs --
 * a deep/enhanced crawl can be slow, but wiring VehicleBackgroundCapability
 * is a separate follow-up (see task 4057390d), not required to reach parity
 * with today's /api/v1/ops behavior.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { fetchInput, optionalBoolean, optionalNumber, optionalString } from "../service.ts";
import type { CrawlService } from "../services/crawl-service.ts";
import type { FetchService } from "../services/fetch-service.ts";
import { withVehicleErrorParity } from "./vehicle-error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 16_384, maxResponseBytes: 1_048_576 };

const FETCH_PROPERTIES = {
	url: { type: "string" },
	format: { type: "string", enum: ["markdown", "lean", "links", "highlights", "tree"] },
	rootSelector: { type: "string" },
	excludeSelectors: { type: "string" },
	tokenBudget: { type: "number" },
	enhanced: { type: "boolean" },
	timeoutMs: { type: "number" },
	query: { type: "string" },
	path: { type: "string" },
	topN: { type: "number" },
	ignoreRobots: { type: "boolean" },
} as const;

export function registerFetchVehicleOperations(registry: VehicleRegistry, fetchService: FetchService, crawlService: CrawlService): void {
	const fetchOperation = defineVehicleOperation({
		name: "fetch",
		version: 1,
		description: "Fetches one URL and returns clean content in the requested format (markdown/lean/links/highlights/tree).",
		input: defineLooseObjectSchema(FETCH_PROPERTIES, ["url"]),
		output: passthroughVehicleSchema,
		permissions: ["web-spider:read"],
		effect: "open-world",
		idempotency: { mode: "safe" },
		limits: LIMITS,
	});
	registry.register(
		OWNER,
		bindVehicleOperation(
			fetchOperation,
			() => async (context) => withVehicleErrorParity(() => fetchService.fetch(fetchInput(context.input as Record<string, unknown>))),
		),
	);

	const crawlOperation = defineVehicleOperation({
		name: "crawl",
		version: 1,
		description: "Crawls from a URL to the given depth, returning content in the requested format across every visited page.",
		input: defineLooseObjectSchema(
			{
				...FETCH_PROPERTIES,
				format: { type: "string", enum: ["markdown", "lean", "highlights"] },
				depth: { type: "number" },
				maxPages: { type: "number" },
				sameDomain: { type: "boolean" },
			},
			["url"],
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
			crawlOperation,
			() => async (context) =>
				withVehicleErrorParity(() => {
					const input = context.input as Record<string, unknown>;
					return crawlService.crawl({
						...fetchInput(input),
						format: optionalString(input, "format") as "markdown" | "lean" | "highlights" | undefined,
						depth: optionalNumber(input, "depth"),
						maxPages: optionalNumber(input, "maxPages"),
						sameDomain: optionalBoolean(input, "sameDomain"),
					});
				}),
		),
	);
}
