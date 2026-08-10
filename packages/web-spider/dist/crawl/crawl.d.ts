import type { SpiderOptions } from "../fetch/spider.js";
import type { ICache } from "../ports.js";
import type { SpideredPage } from "../types.js";
import { type CrawlBudget, type CrawlStopReason } from "./budget.js";
import { type PageClassification, type PageClassifier } from "./classifier.js";
import { type LinkScorer } from "./frontier.js";
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
export declare function crawl(startUrl: string, opts?: CrawlOptions): Promise<CrawlResult>;
//# sourceMappingURL=crawl.d.ts.map