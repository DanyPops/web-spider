import { SpiderCache } from "../cache/cache.js";
import { RobotsCache } from "../fetch/robots.js";
import { createDefaultHttpClient, spider } from "../fetch/spider.js";
import { DomainThrottle } from "../fetch/throttle.js";
import { fetchSitemapUrls } from "../sources/sitemap.js";
import { DefaultCrawlBudget } from "./budget.js";
import { HeuristicPageClassifier, renderLinkList } from "./classifier.js";
import { HeuristicLinkScorer, orderFrontier } from "./frontier.js";
import { PageGraph } from "./graph.js";
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
export async function crawl(startUrl, opts = {}) {
    const { maxDepth = 2, maxPages = 50, sameDomainOnly = true, concurrency = 3, delayMs = 500, cache = new SpiderCache(), graph = new PageGraph(), onPage, urlFilter, respectRobots = true, useSitemap = true, linkScorer = new HeuristicLinkScorer(), pageClassifier = new HeuristicPageClassifier(), budget = new DefaultCrawlBudget({ maxPages, maxTotalChars: opts.maxTotalChars, deadlineMs: opts.deadlineMs }), discoverOnly = false, crawlUrls, ...spiderOpts } = opts;
    const throttle = spiderOpts.throttle ?? new DomainThrottle({ minDelayMs: delayMs });
    const robotsCache = spiderOpts.robotsCache ?? (respectRobots ? new RobotsCache(spiderOpts.userAgent) : undefined);
    const httpClient = spiderOpts.httpClient;
    const startDomain = new URL(startUrl).hostname;
    const pages = new Map();
    const errors = new Map();
    const classifications = new Map();
    const seen = new Set();
    const crawlStartedAt = Date.now();
    let charsUsed = 0;
    let stopReason = "complete";
    const budgetState = () => ({ pagesUsed: pages.size, errorsUsed: errors.size, charsUsed, elapsedMs: Date.now() - crawlStartedAt });
    const budgetExhausted = () => budget.isExhausted(budgetState());
    const shouldVisit = (url) => {
        if (seen.has(url))
            return false;
        if (budgetExhausted())
            return false;
        try {
            const u = new URL(url);
            if (!["http:", "https:"].includes(u.protocol))
                return false;
            if (sameDomainOnly && u.hostname !== startDomain)
                return false;
        }
        catch {
            return false;
        }
        if (urlFilter && !urlFilter(url))
            return false;
        return true;
    };
    // Throttle and robots.txt are handled inside spider() via shared instances.
    const fetchBatch = async (urls, depth) => {
        let index = 0;
        let inFlight = 0;
        let completed = 0;
        await new Promise((resolve) => {
            const tryNext = () => {
                while (inFlight < concurrency && index < urls.length) {
                    const url = urls[index++];
                    inFlight++;
                    const fetch_ = cache.has(url) ? Promise.resolve(cache.get(url)) : spider(url, { ...spiderOpts, throttle, robotsCache });
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
                        .catch((err) => {
                        errors.set(url, err instanceof Error ? err : new Error(String(err)));
                    })
                        .finally(() => {
                        completed++;
                        inFlight--;
                        if (completed === urls.length)
                            resolve();
                        else
                            tryNext();
                    });
                }
            };
            tryNext();
        });
    };
    const selectiveMode = crawlUrls !== undefined && crawlUrls.length > 0;
    let frontier;
    if (selectiveMode) {
        // crawlUrls: selective second-phase crawl, no sitemap seeding, no re-discovery.
        frontier = crawlUrls.filter(shouldVisit);
        for (const u of frontier)
            seen.add(u);
    }
    else {
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
        if (frontier.length === 0)
            break;
        const remaining = budget.remaining(budgetState());
        const batch = frontier.slice(0, remaining);
        const truncatedByBudget = batch.length < frontier.length;
        await fetchBatch(batch, depth);
        // A batch trimmed by budget.remaining() is a real budget-limited stop even
        // when it also happens to coincide with reaching maxDepth right after.
        if (truncatedByBudget) {
            stopReason = budget.reason?.(budgetState()) ?? "max-pages";
        }
        if (depth === effectiveMaxDepth)
            break;
        const candidates = [];
        for (const url of batch) {
            const page = pages.get(url);
            if (!page)
                continue;
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
//# sourceMappingURL=crawl.js.map