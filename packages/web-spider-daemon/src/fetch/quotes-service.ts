/**
 * Standalone "resource finder" application service -- given a query and an
 * explicit set of URLs (typically the result list from a prior `search`
 * call), fetches each one and returns ranked, verbatim BM25F quotes per
 * url as a "resource card" list: `{ url, title?, author?, publishedAt?,
 * quotes: [...] }` or `{ url, error }` for a url that failed to fetch.
 *
 * Deliberately independent of CrawlService's frontier/depth/BFS machinery --
 * this never discovers new URLs, it only extracts from the ones it's given
 * (see docs/web-fetch-api.md and the "standalone quote/resource-finder
 * extraction mode" design task). Reuses `crawl()`'s own `crawlUrls`
 * selective-fetch mode (fetch exactly this URL set, no discovery, no BFS)
 * for the actual network/cache/robots/throttle work rather than
 * reimplementing it -- the same proven path CrawlService's own
 * `crawlUrls + format: "highlights"` combination already exercises.
 *
 * Never produces an LLM-digested answer -- see AnswerResult in
 * @danypops/web-spider's ports.ts for that deliberately separate,
 * deliberately unexposed concern.
 */

import type { Logger } from "@danypops/vehicle-server/logging";
import { crawl, type IHttpClient, type IRobotsChecker, type IThrottle, searchPages } from "@danypops/web-spider";
import type { CacheStore } from "../cache/cache-store.ts";
import {
	FETCH_DEFAULT_TIMEOUT_MS,
	FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
	QUOTES_DEFAULT_PER_URL,
	QUOTES_DEFAULT_TOTAL,
	QUOTES_MAX_URLS,
	QUOTES_PER_URL_CEILING,
	QUOTES_TOTAL_CEILING,
} from "../constants.ts";
import { highlightHit } from "../format.ts";
import { resolveSourcesOption } from "./content-sources.ts";

export interface QuotesOperationInput {
	query: string;
	urls: string[];
	/** Per-url quote cap -- no single url's resource card may exceed this, even when it dominates the combined BM25F ranking (server-clamped to QUOTES_PER_URL_CEILING). */
	maxQuotesPerUrl?: number;
	/** Combined quote cap across every resource (server-clamped to QUOTES_TOTAL_CEILING). */
	maxQuotesTotal?: number;
	timeoutMs?: number;
	enhanced?: boolean;
	/** Named ContentSourceStrategy(s) applied to every url this request fetches -- see FetchOperationInput.sources. */
	sources?: string[];
	/** Explicit, opt-in bypass of the robots.txt check for every url this request fetches. Never a default -- every use is logged. */
	ignoreRobots?: boolean;
}

export type QuotesOperationOutput = Record<string, unknown>;

export interface QuotesServiceDeps {
	cache: CacheStore;
	throttle: IThrottle;
	robotsCache: IRobotsChecker;
	getPlaywrightClient: () => IHttpClient;
	/** Overrides crawl()'s built-in real-fetch() adapter for every (non-enhanced) request -- see FetchServiceDeps. */
	defaultHttpClient?: IHttpClient;
	/** Logs every ignoreRobots use. Optional so existing tests/wiring that don't care about audit logging keep working unchanged. */
	logger?: Logger;
}

function clamp(value: number | undefined, fallback: number, ceiling: number, floor = 1): number {
	const requested = Number.isFinite(value) ? Math.floor(value as number) : fallback;
	return Math.max(floor, Math.min(ceiling, requested));
}

/** Preserves first-occurrence order -- a repeated url in the request still gets exactly one resource entry. */
function dedupe(urls: string[]): string[] {
	return [...new Set(urls)];
}

export class QuotesService {
	constructor(private readonly deps: QuotesServiceDeps) {}

	async quotes(input: QuotesOperationInput): Promise<QuotesOperationOutput> {
		if (!input.query?.trim()) throw new Error("quotes requires a non-empty query");
		const urls = dedupe(input.urls ?? []).slice(0, QUOTES_MAX_URLS);
		if (urls.length === 0) throw new Error("quotes requires at least one url");

		if (input.ignoreRobots) {
			this.deps.logger?.warn("robots_txt_ignored", { urls, operation: "quotes" });
		}

		const maxQuotesPerUrl = clamp(input.maxQuotesPerUrl, QUOTES_DEFAULT_PER_URL, QUOTES_PER_URL_CEILING);
		const maxQuotesTotal = clamp(input.maxQuotesTotal, QUOTES_DEFAULT_TOTAL, QUOTES_TOTAL_CEILING);

		const result = await crawl(urls[0]!, {
			crawlUrls: urls,
			sameDomainOnly: false,
			useSitemap: false,
			cache: this.deps.cache,
			throttle: this.deps.throttle,
			robotsCache: input.ignoreRobots ? undefined : this.deps.robotsCache,
			respectRobots: !input.ignoreRobots,
			httpClient: input.enhanced ? this.deps.getPlaywrightClient() : this.deps.defaultHttpClient,
			timeoutMs: input.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS,
			contentSources: resolveSourcesOption(input.sources),
		});

		const pages = [...result.pages.values()];
		// Rank generously across the whole corpus first (BM25F scoring is
		// corpus-relative), then cap per-url below -- topN here is only large
		// enough to guarantee every url's own best matches are still present
		// before the per-url cap trims them, not the final bound.
		const hits = searchPages(pages, input.query, {
			topN: Math.max(maxQuotesTotal, urls.length * maxQuotesPerUrl),
			snippetRadius: FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
		});

		const perUrlCount = new Map<string, number>();
		let totalCount = 0;
		const cappedByUrl = new Map<string, Record<string, unknown>[]>();
		for (const hit of hits) {
			if (totalCount >= maxQuotesTotal) break;
			const usedForUrl = perUrlCount.get(hit.url) ?? 0;
			if (usedForUrl >= maxQuotesPerUrl) continue;
			const page = pages.find((p) => p.url === hit.url);
			const list = cappedByUrl.get(hit.url) ?? [];
			list.push(highlightHit(hit, page?.chunks ?? []));
			cappedByUrl.set(hit.url, list);
			perUrlCount.set(hit.url, usedForUrl + 1);
			totalCount += 1;
		}

		const resources = urls.map((url) => {
			const error = result.errors.get(url);
			if (error) return { url, error: error.message };
			const page = pages.find((p) => p.url === url);
			const resource: Record<string, unknown> = { url };
			if (page?.title) resource.title = page.title;
			if (page?.author) resource.author = page.author;
			if (page?.publishedAt) resource.publishedAt = page.publishedAt;
			resource.quotes = cappedByUrl.get(url) ?? [];
			return resource;
		});

		return {
			query: input.query,
			urlsRequested: urls.length,
			...(result.errors.size ? { errors: result.errors.size, errorUrls: [...result.errors.keys()] } : {}),
			resources,
		};
	}
}
