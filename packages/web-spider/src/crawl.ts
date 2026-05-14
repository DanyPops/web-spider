import { SpiderCache } from "./cache.js";
import { PageGraph } from "./graph.js";
import type { SpiderOptions } from "./spider.js";
import { spider } from "./spider.js";
import type { SpideredPage } from "./types.js";

export interface CrawlOptions extends SpiderOptions {
	/** How many link hops from the start URL (default 2) */
	maxDepth?: number;
	/** Hard cap on total pages spidered (default 50) */
	maxPages?: number;
	/** Only follow links on the same domain as the start URL (default true) */
	sameDomainOnly?: boolean;
	/** Max concurrent fetches per depth level (default 3) */
	concurrency?: number;
	/** Delay between fetches in ms (default 400) */
	delayMs?: number;
	/** Bring your own cache — already-spidered URLs are skipped */
	cache?: SpiderCache;
	/** Bring your own graph — nodes/edges added as pages are spidered */
	graph?: PageGraph;
	/** Called with each successfully spidered page */
	onPage?: (page: SpideredPage, depth: number) => void;
	/** Return false to skip a URL before fetching it */
	urlFilter?: (url: string) => boolean;
}

export interface CrawlResult {
	pages: Map<string, SpideredPage>;
	graph: PageGraph;
	errors: Map<string, Error>;
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
		delayMs = 400,
		cache = new SpiderCache(),
		graph = new PageGraph(),
		onPage,
		urlFilter,
		...spiderOpts
	} = opts;

	const startDomain = new URL(startUrl).hostname;
	const pages = new Map<string, SpideredPage>();
	const errors = new Map<string, Error>();
	const seen = new Set<string>();

	const shouldVisit = (url: string): boolean => {
		if (seen.has(url)) return false;
		if (pages.size + errors.size >= maxPages) return false;
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

	// Fetch a batch of URLs with concurrency limit and polite delay
	const fetchBatch = async (urls: string[], depth: number): Promise<void> => {
		let index = 0;
		let inFlight = 0;
		let completed = 0;

		await new Promise<void>((resolve) => {
			const tryNext = (): void => {
				while (inFlight < concurrency && index < urls.length) {
					const url = urls[index++];
					inFlight++;

					const delay =
						delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs * (index - 1))) : Promise.resolve();

					const fetch_ = cache.has(url)
						? Promise.resolve(cache.get(url)!)
						: delay.then(() => spider(url, spiderOpts));

					fetch_
						.then((page) => {
							pages.set(url, page);
							cache.set(url, page);
							graph.addPage(page);
							onPage?.(page, depth);
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

	// BFS level by level
	let frontier = [startUrl];
	seen.add(startUrl);

	for (let depth = 0; depth <= maxDepth; depth++) {
		if (frontier.length === 0) break;
		if (pages.size + errors.size >= maxPages) break;

		// Cap the frontier to not exceed maxPages
		const remaining = maxPages - pages.size - errors.size;
		const batch = frontier.slice(0, remaining);

		await fetchBatch(batch, depth);

		if (depth === maxDepth) break;

		// Collect next level from all pages spidered at this depth
		const nextFrontier: string[] = [];
		for (const url of batch) {
			const page = pages.get(url);
			if (!page) continue;
			for (const link of page.links) {
				if (shouldVisit(link.href)) {
					seen.add(link.href);
					nextFrontier.push(link.href);
				}
			}
		}
		frontier = nextFrontier;
	}

	return { pages, graph, errors };
}
