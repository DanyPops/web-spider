import { SpiderCache } from "./cache.js";
import { PageGraph } from "./graph.js";
import type { SpiderOptions } from "./spider.js";
import type { SpideredPage } from "./types.js";
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
    cache?: SpiderCache;
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
export declare function crawl(startUrl: string, opts?: CrawlOptions): Promise<CrawlResult>;
//# sourceMappingURL=crawl.d.ts.map