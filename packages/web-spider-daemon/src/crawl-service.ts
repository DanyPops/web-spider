/**
 * Depth-bounded crawl application service — ports packages/pi-extension/src/index.ts's
 * handleCrawl logic into the daemon, composed against the SQLite-backed
 * CacheStore. Server-side bounds (design doc §5) are enforced here, not just
 * documented as client-side defaults — a CLI or any other future caller must
 * not be able to request an unbounded crawl.
 */
import { crawl, searchPages, type IHttpClient, type IRobotsChecker, type IThrottle } from "@danypops/web-spider";
import {
	CRAWL_DEFAULT_MAX_DEPTH,
	CRAWL_DEFAULT_MAX_PAGES,
	CRAWL_HIGHLIGHTS_DEFAULT_TOP_N,
	CRAWL_MAX_DEPTH_CEILING,
	CRAWL_MAX_PAGES_CEILING,
	FETCH_DEFAULT_TIMEOUT_MS,
	FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
} from "./constants.ts";
import { highlightHit, leanOutput, omitEmpty } from "./format.ts";
import type { CacheStore } from "./ports/cache-store.ts";

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
}

export type CrawlOperationOutput = Record<string, unknown>;

export interface CrawlServiceDeps {
	cache: CacheStore;
	throttle: IThrottle;
	robotsCache: IRobotsChecker;
	getPlaywrightClient: () => IHttpClient;
	/** Overrides crawl()'s built-in real-fetch() adapter for every (non-enhanced) request. See FetchServiceDeps. */
	defaultHttpClient?: IHttpClient;
}

function clamp(value: number | undefined, fallback: number, ceiling: number, floor = 0): number {
	const requested = Number.isFinite(value) ? Math.floor(value as number) : fallback;
	return Math.max(floor, Math.min(ceiling, requested));
}

export class CrawlService {
	constructor(private readonly deps: CrawlServiceDeps) {}

	async crawl(input: CrawlOperationInput): Promise<CrawlOperationOutput> {
		const format = input.format ?? "markdown";
		const depth = clamp(input.depth, CRAWL_DEFAULT_MAX_DEPTH, CRAWL_MAX_DEPTH_CEILING);
		const maxPages = clamp(input.maxPages, CRAWL_DEFAULT_MAX_PAGES, CRAWL_MAX_PAGES_CEILING, 1);

		const result = await crawl(input.url, {
			maxDepth: depth,
			maxPages,
			sameDomainOnly: input.sameDomain ?? true,
			cache: this.deps.cache,
			rootSelector: input.rootSelector,
			excludeSelectors: input.excludeSelectors,
			tokenBudget: input.tokenBudget,
			timeoutMs: input.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS,
			throttle: this.deps.throttle,
			robotsCache: this.deps.robotsCache,
			httpClient: input.enhanced ? this.deps.getPlaywrightClient() : this.deps.defaultHttpClient,
		});

		const pages = [...result.pages.values()];
		const errorsObj = result.errors.size ? { errors: result.errors.size, errorUrls: [...result.errors.keys()] } : {};

		if (format === "highlights") {
			if (!input.query?.trim()) throw new Error("highlights format requires a query");
			const hits = searchPages(pages, input.query, { topN: CRAWL_HIGHLIGHTS_DEFAULT_TOP_N, snippetRadius: FETCH_HIGHLIGHTS_SNIPPET_RADIUS });
			return {
				query: input.query,
				pagesSearched: pages.length,
				...errorsObj,
				hits: hits.map((hit) => ({ url: hit.url, ...highlightHit(hit, pages.find((p) => p.url === hit.url)?.chunks ?? []) })),
			};
		}

		if (format === "lean") {
			return { pagesFound: result.pages.size, ...errorsObj, pages: pages.map(leanOutput) };
		}

		// markdown (default) — crawl summary, not full page bodies; see docs/web-fetch-api.md "Crawl output".
		return {
			pagesFound: result.pages.size,
			...errorsObj,
			note: "All pages cached — use fetch(depth=0, format=highlights, query=...) to search them.",
			pages: pages.map((page) => omitEmpty({ url: page.url, title: page.title, description: page.description, wordCount: page.wordCount, tags: page.tags })),
		};
	}
}
