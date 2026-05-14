import { SpiderCache } from "./cache.js";
import { PageGraph } from "./graph.js";
import { RobotsCache } from "./robots.js";
import { spider } from "./spider.js";
import { DomainThrottle } from "./throttle.js";
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
    const { maxDepth = 2, maxPages = 50, sameDomainOnly = true, concurrency = 3, delayMs = 500, cache = new SpiderCache(), graph = new PageGraph(), onPage, urlFilter, respectRobots = true, ...spiderOpts } = opts;
    // Build shared throttle and robots cache for the whole crawl.
    const throttle = spiderOpts.throttle ?? new DomainThrottle({ minDelayMs: delayMs });
    const robotsCache = spiderOpts.robotsCache ?? (respectRobots ? new RobotsCache(spiderOpts.userAgent) : undefined);
    const startDomain = new URL(startUrl).hostname;
    const pages = new Map();
    const errors = new Map();
    const seen = new Set();
    const shouldVisit = (url) => {
        if (seen.has(url))
            return false;
        if (pages.size + errors.size >= maxPages)
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
    // Fetch a batch of URLs with concurrency limit.
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
                    const fetch_ = cache.has(url)
                        ? Promise.resolve(cache.get(url))
                        : spider(url, { ...spiderOpts, throttle, robotsCache });
                    fetch_
                        .then((page) => {
                        pages.set(url, page);
                        cache.set(url, page);
                        graph.addPage(page);
                        onPage?.(page, depth);
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
    // BFS level by level
    let frontier = [startUrl];
    seen.add(startUrl);
    for (let depth = 0; depth <= maxDepth; depth++) {
        if (frontier.length === 0)
            break;
        if (pages.size + errors.size >= maxPages)
            break;
        // Cap the frontier to not exceed maxPages
        const remaining = maxPages - pages.size - errors.size;
        const batch = frontier.slice(0, remaining);
        await fetchBatch(batch, depth);
        if (depth === maxDepth)
            break;
        // Collect next level from all pages spidered at this depth
        const nextFrontier = [];
        for (const url of batch) {
            const page = pages.get(url);
            if (!page)
                continue;
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
//# sourceMappingURL=crawl.js.map