/**
 * Depth-bounded crawl application service — ports packages/pi-web-spider/src/index.ts's
 * handleCrawl logic into the daemon, composed against the SQLite-backed
 * CacheStore. Server-side bounds (design doc §5) are enforced here, not just
 * documented as client-side defaults — a CLI or any other future caller must
 * not be able to request an unbounded crawl.
 */

import type { Logger } from "@danypops/vehicle-server/logging";
import { crawl, type IHttpClient, type IRobotsChecker, type IThrottle, type PageClassification, searchPages } from "@danypops/web-spider";
import type { CacheStore } from "../cache/cache-store.ts";
import { withMaxAge } from "../cache/freshness-view.ts";
import {
	CRAWL_DEFAULT_DEADLINE_MS,
	CRAWL_DEFAULT_MAX_DEPTH,
	CRAWL_DEFAULT_MAX_PAGES,
	CRAWL_DOMAIN_FILTER_MAX_COUNT,
	CRAWL_HIGHLIGHTS_DEFAULT_TOP_N,
	CRAWL_MAX_DEADLINE_MS_CEILING,
	CRAWL_MAX_DEPTH_CEILING,
	CRAWL_MAX_PAGES_CEILING,
	CRAWL_MAX_TOTAL_CHARS_CEILING,
	CRAWL_URLS_MAX_COUNT,
	FETCH_DEFAULT_TIMEOUT_MS,
	FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
} from "../constants.ts";
import { highlightHit, leanOutput, omitEmpty } from "../format.ts";
import { resolveSourcesOption } from "./content-sources.ts";
import { buildDomainFilter } from "./domain-filter.ts";

export type CrawlFormat = "markdown" | "lean" | "highlights";

export interface CrawlOperationInput {
	url: string;
	format?: CrawlFormat;
	depth?: number;
	maxPages?: number;
	sameDomain?: boolean;
	rootSelector?: string;
	excludeSelectors?: string;
	tokenBudget?: number;
	enhanced?: boolean;
	timeoutMs?: number;
	query?: string;
	/**
	 * Explicit, opt-in bypass of the robots.txt check for every page this
	 * crawl visits. Never a default -- every use is logged. A crawl is
	 * exactly the case autonomous-bulk-scraping concerns are usually about,
	 * so this is a heavier decision than the single-fetch equivalent; still
	 * the operator's own explicit choice on their own infrastructure.
	 */
	ignoreRobots?: boolean;
	/** URL map only -- pages are still fetched to discover links, but no content body is returned. */
	discoverOnly?: boolean;
	/**
	 * Selective second-phase crawl of exactly these URLs, no re-discovery.
	 * Clamped server-side to CRAWL_URLS_MAX_COUNT entries.
	 */
	crawlUrls?: string[];
	/** Total extracted-content character cap across the whole crawl. Clamped server-side. */
	maxTotalChars?: number;
	/** Wall-clock cap for the whole crawl, in milliseconds. Clamped server-side. */
	deadlineMs?: number;
	/** Named ContentSourceStrategy(s) applied to every page this crawl fetches -- see FetchOperationInput.sources. */
	sources?: string[];
	/** Skip a discovered URL whose hostname matches (or is a subdomain of) any of these. Clamped server-side to CRAWL_DOMAIN_FILTER_MAX_COUNT entries. See src/fetch/domain-filter.ts. */
	excludeDomains?: string[];
	/** Only follow a discovered URL whose hostname matches (or is a subdomain of) one of these. Clamped server-side to CRAWL_DOMAIN_FILTER_MAX_COUNT entries. See src/fetch/domain-filter.ts. */
	includeDomains?: string[];
	/** Reject an already-cached page older than this many ms, treating it as a miss for this crawl -- see FetchOperationInput.maxCacheAgeMs and src/cache/freshness-view.ts. The re-fetched page is still written back to the shared cache normally. */
	maxCacheAgeMs?: number;
}

export type CrawlOperationOutput = Record<string, unknown>;

export interface CrawlServiceDeps {
	cache: CacheStore;
	throttle: IThrottle;
	robotsCache: IRobotsChecker;
	getPlaywrightClient: () => IHttpClient;
	/** Overrides crawl()'s built-in real-fetch() adapter for every (non-enhanced) request. See FetchServiceDeps. */
	defaultHttpClient?: IHttpClient;
	/** Logs every ignoreRobots use. Optional so existing tests/wiring that don't care about audit logging keep working unchanged. */
	logger?: Logger;
}

function clamp(value: number | undefined, fallback: number, ceiling: number, floor = 0): number {
	const requested = Number.isFinite(value) ? Math.floor(value as number) : fallback;
	return Math.max(floor, Math.min(ceiling, requested));
}

/** Clamps an optional cap: only bounds the ceiling when the caller actually supplied one; omitted stays uncapped. */
function clampOptional(value: number | undefined, ceiling: number, floor = 1): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(floor, Math.min(ceiling, Math.floor(value)));
}

/** Merges a crawl-level page_type/content_ok classification onto an already-shaped output page. */
function withClassification(output: Record<string, unknown>, classification: PageClassification | undefined): Record<string, unknown> {
	if (!classification) return output;
	return { ...output, pageType: classification.pageType, contentOk: classification.contentOk };
}

export class CrawlService {
	constructor(private readonly deps: CrawlServiceDeps) {}

	async crawl(input: CrawlOperationInput): Promise<CrawlOperationOutput> {
		if (input.ignoreRobots) {
			this.deps.logger?.warn("robots_txt_ignored", { url: input.url, operation: "crawl" });
		}
		const format = input.format ?? "markdown";
		const depth = clamp(input.depth, CRAWL_DEFAULT_MAX_DEPTH, CRAWL_MAX_DEPTH_CEILING);
		const maxPages = clamp(input.maxPages, CRAWL_DEFAULT_MAX_PAGES, CRAWL_MAX_PAGES_CEILING, 1);
		const deadlineMs = clamp(input.deadlineMs, CRAWL_DEFAULT_DEADLINE_MS, CRAWL_MAX_DEADLINE_MS_CEILING, 1_000);
		const maxTotalChars = clampOptional(input.maxTotalChars, CRAWL_MAX_TOTAL_CHARS_CEILING);
		const crawlUrls = input.crawlUrls?.slice(0, CRAWL_URLS_MAX_COUNT);
		const urlFilter = buildDomainFilter(
			input.excludeDomains?.slice(0, CRAWL_DOMAIN_FILTER_MAX_COUNT),
			input.includeDomains?.slice(0, CRAWL_DOMAIN_FILTER_MAX_COUNT),
		);
		const cache = input.maxCacheAgeMs !== undefined ? withMaxAge(this.deps.cache, input.maxCacheAgeMs) : this.deps.cache;

		const result = await crawl(input.url, {
			maxDepth: depth,
			maxPages,
			sameDomainOnly: input.sameDomain ?? true,
			cache,
			rootSelector: input.rootSelector,
			excludeSelectors: input.excludeSelectors,
			tokenBudget: input.tokenBudget,
			timeoutMs: input.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS,
			throttle: this.deps.throttle,
			robotsCache: input.ignoreRobots ? undefined : this.deps.robotsCache,
			respectRobots: !input.ignoreRobots,
			httpClient: input.enhanced ? this.deps.getPlaywrightClient() : this.deps.defaultHttpClient,
			discoverOnly: input.discoverOnly,
			crawlUrls,
			maxTotalChars,
			deadlineMs,
			contentSources: resolveSourcesOption(input.sources),
			urlFilter,
		});

		const pages = [...result.pages.values()];
		const errorsObj = result.errors.size ? { errors: result.errors.size, errorUrls: [...result.errors.keys()] } : {};
		const nextActionObj = { nextAction: result.nextAction };

		if (format === "highlights") {
			if (!input.query?.trim()) throw new Error("highlights format requires a query");
			const hits = searchPages(pages, input.query, {
				topN: CRAWL_HIGHLIGHTS_DEFAULT_TOP_N,
				snippetRadius: FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
			});
			return {
				query: input.query,
				pagesSearched: pages.length,
				...errorsObj,
				...nextActionObj,
				hits: hits.map((hit) => ({ url: hit.url, ...highlightHit(hit, pages.find((p) => p.url === hit.url)?.chunks ?? []) })),
			};
		}

		if (format === "lean") {
			return {
				pagesFound: result.pages.size,
				...errorsObj,
				...nextActionObj,
				pages: pages.map((page) => withClassification(leanOutput(page), result.classifications.get(page.url))),
			};
		}

		// markdown (default) — crawl summary, not full page bodies; see docs/web-fetch-api.md "Crawl output".
		// No "note" field here: the historical "use web_fetch(depth=0, ...)" guidance
		// names a specific Pi tool and is added by that tool's own adapter layer
		// (packages/pi-web-spider), not by this daemon — a CLI caller has no such tool.
		return {
			pagesFound: result.pages.size,
			...errorsObj,
			...nextActionObj,
			pages: pages.map((page) =>
				withClassification(
					omitEmpty({ url: page.url, title: page.title, description: page.description, wordCount: page.wordCount, tags: page.tags }),
					result.classifications.get(page.url),
				),
			),
		};
	}
}
