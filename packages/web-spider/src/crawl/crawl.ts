import { SpiderCache } from "../cache/cache.js";
import { RobotsCache } from "../fetch/robots.js";
import type { SpiderOptions } from "../fetch/spider.js";
import { createDefaultHttpClient, spider } from "../fetch/spider.js";
import { DomainThrottle } from "../fetch/throttle.js";
import type { ICache } from "../ports.js";
import { fetchSitemapUrls } from "../sources/sitemap.js";
import type { SpideredPage } from "../types.js";
import { type CrawlBudget, type CrawlStopReason, DefaultCrawlBudget } from "./budget.js";
import { HeuristicPageClassifier, type PageClassification, type PageClassifier, renderLinkList } from "./classifier.js";
import { HeuristicLinkScorer, type LinkScoreContext, type LinkScorer, orderFrontier } from "./frontier.js";
import { PageGraph } from "./graph.js";

export interface CrawlOptions extends SpiderOptions {
	/** How many link hops from the start URL (default 2) */
	maxDepth?: number;
	/** Hard cap on total pages spidered (default 50) */
	maxPages?: number;
	/** Only follow links on the same domain as the start URL (default true) */
	sameDomainOnly?: boolean;
	/** Max concurrent fetches (default 3) */
	concurrency?: number;
	/**
	 * Minimum delay between requests to the same domain (ms).
	 * When a throttle is provided this sets its minDelayMs.
	 * Default 500.
	 */
	delayMs?: number;
	/** Bring your own cache — already-spidered URLs are skipped */
	cache?: ICache<string, SpideredPage>;
	/** Bring your own graph — nodes/edges added as pages are spidered */
	graph?: PageGraph;
	/** Called with each successfully spidered page */
	onPage?: (page: SpideredPage, depth: number) => void;
	/** Return false to skip a URL before fetching it */
	urlFilter?: (url: string) => boolean;
	/**
	 * Whether to check and respect robots.txt for each domain (default true).
	 * Automatically creates a RobotsCache if not provided via SpiderOptions.
	 */
	respectRobots?: boolean;
	/**
	 * Attempt to fetch /sitemap.xml before BFS to seed the frontier with
	 * all known URLs. Falls back to normal BFS on any error (default true).
	 */
	useSitemap?: boolean;
	/**
	 * Strategy for ordering discovered candidate URLs within one frontier
	 * level. Defaults to HeuristicLinkScorer (best-first: content-likely paths
	 * boosted, app-chrome paths penalized, shallower depth preferred).
	 */
	linkScorer?: LinkScorer;
	/**
	 * Strategy for classifying each fetched page (article/list/js_shell) and
	 * reporting whether its content is usable. Defaults to HeuristicPageClassifier.
	 */
	pageClassifier?: PageClassifier;
	/**
	 * Strategy owning "should we stop fetching" bookkeeping. Defaults to
	 * DefaultCrawlBudget(maxPages, maxTotalChars, deadlineMs).
	 */
	budget?: CrawlBudget;
	/**
	 * Total extracted-content character cap across the whole crawl (sum of
	 * fetched pages' markdown.length). Only used when `budget` is not
	 * supplied directly. Omit for no cap.
	 */
	maxTotalChars?: number;
	/**
	 * Wall-clock cap for the whole crawl, in milliseconds (default 120000).
	 * Only used when `budget` is not supplied directly.
	 */
	deadlineMs?: number;
	/**
	 * When true, pages are still fetched to discover their links, but the
	 * stored/returned pages have markdown/chunks stripped -- an honest
	 * "URL map, no content body" result (default false).
	 */
	discoverOnly?: boolean;
	/**
	 * Selective second-phase crawl: when non-empty, the frontier is exactly
	 * these URLs (still filtered by sameDomainOnly/urlFilter/budget) -- no
	 * sitemap seeding, and no further link-following after that one batch,
	 * regardless of maxDepth. `startUrl` is used only to resolve relative
	 * same-domain checks, not fetched itself.
	 */
	crawlUrls?: string[];
}

export interface CrawlResult {
	pages: Map<string, SpideredPage>;
	graph: PageGraph;
	errors: Map<string, Error>;
	/** Classification recorded per successfully fetched page (see pageClassifier). */
	classifications: Map<string, PageClassification>;
	/** Why the crawl stopped -- "complete" means the frontier simply ran out, not a budget limit. */
	nextAction: CrawlStopReason;
}

/**
 * Recursive BFS crawler.
 *
 * Starts at `startUrl`, spiders it, extracts links, filters them, then
 * recurses up to `maxDepth` hops. Respects `maxPages`, `sameDomainOnly`,
 * and `urlFilter`. Populates the provided (or freshly created) cache and
 * graph as it goes.
 *
 * Concurrency is bounded per depth level — we fully finish each level
 * before proceeding, giving BFS ordering and predictable memory use.
 */
export async function crawl(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
	const {
		maxDepth = 2,
		maxPages = 50,
		sameDomainOnly = true,
		concurrency = 3,
		delayMs = 500,
		cache = new SpiderCache() as ICache<string, SpideredPage>,
		graph = new PageGraph(),
		onPage,
		urlFilter,
		respectRobots = true,
		useSitemap = true,
		linkScorer = new HeuristicLinkScorer(),
		pageClassifier = new HeuristicPageClassifier(),
		budget = new DefaultCrawlBudget({ maxPages, maxTotalChars: opts.maxTotalChars, deadlineMs: opts.deadlineMs }),
		discoverOnly = false,
		crawlUrls,
		...spiderOpts
	} = opts;

	const throttle = spiderOpts.throttle ?? new DomainThrottle({ minDelayMs: delayMs });
	const robotsCache = spiderOpts.robotsCache ?? (respectRobots ? new RobotsCache(spiderOpts.userAgent) : undefined);
	const httpClient = spiderOpts.httpClient;

	const startDomain = new URL(startUrl).hostname;
	const pages = new Map<string, SpideredPage>();
	const errors = new Map<string, Error>();
	const classifications = new Map<string, PageClassification>();
	const seen = new Set<string>();
	const crawlStartedAt = Date.now();
	let charsUsed = 0;
	let stopReason: CrawlStopReason = "complete";

	const budgetState = () => ({ pagesUsed: pages.size, errorsUsed: errors.size, charsUsed, elapsedMs: Date.now() - crawlStartedAt });
	const budgetExhausted = (): boolean => budget.isExhausted(budgetState());

	const shouldVisit = (url: string): boolean => {
		if (seen.has(url)) return false;
		if (budgetExhausted()) return false;
		try {
			const u = new URL(url);
			if (!["http:", "https:"].includes(u.protocol)) return false;
			if (sameDomainOnly && u.hostname !== startDomain) return false;
		} catch {
			return false;
		}
		if (urlFilter && !urlFilter(url)) return false;
		return true;
	};

	// Throttle and robots.txt are handled inside spider() via shared instances.
	const fetchBatch = async (urls: string[], depth: number): Promise<void> => {
		let index = 0;
		let inFlight = 0;
		let completed = 0;

		await new Promise<void>((resolve) => {
			const tryNext = (): void => {
				while (inFlight < concurrency && index < urls.length) {
					const url = urls[index++];
					inFlight++;

					const fetch_ = cache.has(url) ? Promise.resolve(cache.get(url)!) : spider(url, { ...spiderOpts, throttle, robotsCache });

					fetch_
						.then((page) => {
							const classification = pageClassifier.classify(page);
							classifications.set(url, classification);
							charsUsed += page.markdown.length;

							// The shared cache always stores spider()'s real, unmodified
							// extraction -- content-adaptive shaping and discoverOnly stripping
							// are per-call presentation transforms, never persisted, so a later
							// non-discoverOnly crawl/fetch of the same URL is never poisoned by
							// this crawl's own reshaping.
							cache.set(url, page);
							graph.addPage(page);

							// Content-adaptive shaping: a "list" page's markdown is reshaped into
							// a clean rendered link list -- this does not re-run extraction (see
							// docs/crawl-strategies.md), it only reshapes what spider() already
							// extracted.
							let stored = page;
							if (classification.pageType === "list") {
								stored = { ...page, markdown: renderLinkList(page) };
							}
							if (discoverOnly) {
								stored = { ...stored, markdown: "", chunks: [] };
							}

							pages.set(url, stored);
							onPage?.(stored, depth);
						})
						.catch((err: unknown) => {
							errors.set(url, err instanceof Error ? err : new Error(String(err)));
						})
						.finally(() => {
							completed++;
							inFlight--;
							if (completed === urls.length) resolve();
							else tryNext();
						});
				}
			};
			tryNext();
		});
	};

	const selectiveMode = crawlUrls !== undefined && crawlUrls.length > 0;

	let frontier: string[];
	if (selectiveMode) {
		// crawlUrls: selective second-phase crawl, no sitemap seeding, no re-discovery.
		frontier = crawlUrls.filter(shouldVisit);
		for (const u of frontier) seen.add(u);
	} else {
		frontier = [startUrl];
		seen.add(startUrl);

		if (useSitemap) {
			const origin = new URL(startUrl).origin;
			const client = httpClient ?? createDefaultHttpClient(spiderOpts.ssrfGuard, spiderOpts.maxResponseBytes);
			const sitemapUrls = await fetchSitemapUrls(origin, client);
			for (const u of sitemapUrls) {
				if (shouldVisit(u)) {
					seen.add(u);
					frontier.push(u);
				}
			}
		}
	}

	const effectiveMaxDepth = selectiveMode ? 0 : maxDepth;

	for (let depth = 0; depth <= effectiveMaxDepth; depth++) {
		// Checked before frontier emptiness: an exhausted budget can itself be
		// *why* the frontier ended up empty (every remaining candidate was
		// rejected by shouldVisit()'s own budget check) -- that must still be
		// reported as a budget-limited stop, not "complete".
		if (budgetExhausted()) {
			stopReason = budget.reason?.(budgetState()) ?? "max-pages";
			break;
		}
		if (frontier.length === 0) break;

		const remaining = budget.remaining(budgetState());
		const batch = frontier.slice(0, remaining);
		const truncatedByBudget = batch.length < frontier.length;

		await fetchBatch(batch, depth);

		// A batch trimmed by budget.remaining() is a real budget-limited stop even
		// when it also happens to coincide with reaching maxDepth right after.
		if (truncatedByBudget) {
			stopReason = budget.reason?.(budgetState()) ?? "max-pages";
		}

		if (depth === effectiveMaxDepth) break;

		const candidates: Array<{ url: string; context: LinkScoreContext }> = [];
		for (const url of batch) {
			const page = pages.get(url);
			if (!page) continue;
			for (const link of page.links) {
				if (shouldVisit(link.href)) {
					seen.add(link.href);
					candidates.push({ url: link.href, context: { depth: depth + 1, sourceUrl: url, link } });
				}
			}
		}
		frontier = orderFrontier(candidates, linkScorer);
	}

	return { pages, graph, errors, classifications, nextAction: stopReason };
}
