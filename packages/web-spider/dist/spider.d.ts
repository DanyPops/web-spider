import type { IHttpClient, IRobotsChecker, IThrottle } from "./ports.js";
import type { DOMNode, LeanPage, SpideredPage } from "./types.js";
export interface SpiderOptions {
    /**
     * ms before aborting the fetch (default 10 000).
     */
    timeoutMs?: number;
    /**
     * Value sent as User-Agent.
     * Default identifies the tool; override for sites that block generic crawlers.
     */
    userAgent?: string;
    /**
     * CSS selector that scopes content extraction to a specific element.
     * Everything outside the matched element is discarded before Readability runs.
     * Example: "article", ".main-content", "#post-body"
     */
    rootSelector?: string;
    /**
     * Comma-separated CSS selectors whose matched elements are removed before
     * extraction. Applied before Readability, so excluded content never reaches
     * the chunks or markdown.
     * Example: "nav, footer, .sidebar, #ads"
     */
    excludeSelectors?: string;
    /**
     * Approximate maximum token budget for the returned content.
     * Markdown is truncated to fit. Rough estimate: 1 token ≈ 4 characters.
     * Does not affect lean view (headings/links are always small).
     * Default: unlimited.
     */
    tokenBudget?: number;
    /**
     * Per-domain throttle — shared across spider() calls to enforce rate limits
     * and exponential backoff on 429/503 responses.
     */
    throttle?: IThrottle;
    /**
     * robots.txt checker — when provided, spider() checks robots.txt before
     * fetching and respects Crawl-delay directives.
     */
    robotsCache?: IRobotsChecker;
    /**
     * HTTP client — defaults to a global fetch() adapter.
     * Inject a stub for testing without real network access.
     */
    httpClient?: IHttpClient;
    /**
     * When true, fetch <img> src URLs found in the article content and attach
     * them as base64-encoded ImageRef objects to SpideredPage.images.
     * Default: false — preserves current behaviour exactly.
     */
    captureImages?: boolean;
    /**
     * Maximum number of images to fetch per page.
     * Default: 10.
     */
    maxImages?: number;
}
/** A page with its full DOM tree attached. */
export interface TreePage extends SpideredPage {
    readonly view: "tree";
    tree: DOMNode;
}
export declare function spider(url: string, opts: SpiderOptions & {
    view: "lean";
}): Promise<LeanPage>;
export declare function spider(url: string, opts: SpiderOptions & {
    view: "tree";
}): Promise<TreePage>;
export declare function spider(url: string, opts?: SpiderOptions & {
    view?: "full";
}): Promise<SpideredPage>;
//# sourceMappingURL=spider.d.ts.map