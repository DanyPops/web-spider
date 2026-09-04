/**
 * Projects ordinary fetch/crawl work and explicit robots-policy bypasses as
 * separate Vehicle operations. The operation name, manifest approval flag,
 * and handler behavior all agree, so a caller cannot smuggle a bypass flag
 * through an ordinary fetch descriptor.
 */
import { bindVehicleOperation, defineLooseObjectSchema, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { CrawlService } from "../fetch/crawl-service.ts";
import type { FetchService } from "../fetch/fetch-service.ts";
import { fetchInput, optionalBoolean, optionalNumber, optionalString, optionalStringArray } from "../service.ts";
import { withVehicleErrorParity } from "./error-parity.ts";

const OWNER = "web-spider";
const LIMITS = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxRequestBytes: 16_384, maxResponseBytes: 1_048_576 };

const FETCH_PROPERTIES = {
	url: { type: "string" },
	format: { type: "string", enum: ["markdown", "lean", "links", "highlights", "tree", "source", "meta"] },
	rootSelector: { type: "string" },
	excludeSelectors: { type: "string" },
	tokenBudget: { type: "number" },
	pdfPageStart: { type: "number" },
	pdfPageEnd: { type: "number" },
	enhanced: { type: "boolean" },
	timeoutMs: { type: "number" },
	query: { type: "string" },
	path: { type: "string" },
	topN: { type: "number" },
	sources: { type: "array" },
	maxCacheAgeMs: { type: "number" },
} as const;

export function registerFetchVehicleOperations(registry: VehicleRegistry, fetchService: FetchService, crawlService: CrawlService): void {
	for (const bypassRobots of [false, true]) {
		const fetchOperation = defineVehicleOperation({
			name: bypassRobots ? "fetch.ignoreRobots" : "fetch",
			version: 1,
			description: bypassRobots
				? "Fetches one URL while explicitly bypassing robots.txt for this approved request."
				: "Fetches one URL and returns clean content in the requested format.",
			input: defineLooseObjectSchema(FETCH_PROPERTIES, ["url"]),
			output: passthroughVehicleSchema,
			permissions: ["web-spider:read"],
			effect: "open-world",
			requiresApproval: bypassRobots,
			idempotency: { mode: "safe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(
				fetchOperation,
				() => async (context) =>
					withVehicleErrorParity(() =>
						fetchService.fetch({ ...fetchInput(context.input as Record<string, unknown>), ignoreRobots: bypassRobots }),
					),
			),
		);
	}

	const crawlProperties = {
		...FETCH_PROPERTIES,
		format: { type: "string", enum: ["markdown", "lean", "highlights"] },
		depth: { type: "number" },
		maxPages: { type: "number" },
		sameDomain: { type: "boolean" },
		discoverOnly: { type: "boolean" },
		crawlUrls: { type: "array" },
		maxTotalChars: { type: "number" },
		deadlineMs: { type: "number" },
		excludeDomains: { type: "array" },
		includeDomains: { type: "array" },
	} as const;
	for (const bypassRobots of [false, true]) {
		const crawlOperation = defineVehicleOperation({
			name: bypassRobots ? "crawl.ignoreRobots" : "crawl",
			version: 1,
			description: bypassRobots
				? "Crawls from a URL while explicitly bypassing robots.txt for this approved request."
				: "Crawls from a URL to the given depth, returning content across every visited page.",
			input: defineLooseObjectSchema(crawlProperties, ["url"]),
			output: passthroughVehicleSchema,
			permissions: ["web-spider:read"],
			effect: "open-world",
			requiresApproval: bypassRobots,
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
							discoverOnly: optionalBoolean(input, "discoverOnly"),
							crawlUrls: optionalStringArray(input, "crawlUrls"),
							maxTotalChars: optionalNumber(input, "maxTotalChars"),
							deadlineMs: optionalNumber(input, "deadlineMs"),
							excludeDomains: optionalStringArray(input, "excludeDomains"),
							includeDomains: optionalStringArray(input, "includeDomains"),
							ignoreRobots: bypassRobots,
						});
					}),
			),
		);
	}
}
