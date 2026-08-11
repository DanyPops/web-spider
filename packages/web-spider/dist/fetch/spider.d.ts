import type { IHttpClient, IRobotsChecker, IThrottle } from "../ports.js";
import type { ContentSourceStrategy } from "../sources/content-source.js";
import type { LeanPage, SpideredPage } from "../types.js";
import { type ContentExtractor, type TreePage } from "./content-extractor.js";
export type { TreePage } from "./content-extractor.js";
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
    /** First PDF page to extract (1-based, inclusive). Defaults to 1. */
    pdfPageStart?: number;
    /** Last PDF page to extract (1-based, inclusive). At most 50 pages per request. */
    pdfPageEnd?: number;
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
    /**
     * When true, probes the target URL's origin for a real llms.txt before
     * the normal fetch+Readability path. If found, returns a page built
     * directly from the llms.txt content (viaStrategy: "llms.txt", url set
     * to the llms.txt URL actually fetched) instead of parsing the requested
     * URL's own HTML. If not found, falls through to the normal path
     * unchanged as if this option were never set.
     * Default: false — preserves the existing fetch contract exactly.
     */
    preferLlmsTxt?: boolean;
    /**
     * When true, probes for a .md sibling of the exact requested URL (e.g.
     * Welcome.html -> Welcome.md) before the normal fetch+Readability path.
     * Verified real against docs.aws.amazon.com; a spreading convention on
     * other documentation platforms too. Checked after preferLlmsTxt (a
     * site-wide index) misses or is disabled. Falls through unchanged when
     * no .md sibling exists.
     * Default: false — preserves the existing fetch contract exactly.
     */
    preferMarkdownVariant?: boolean;
    /**
     * When true and the URL looks like a MediaWiki article (Wikipedia,
     * Wiktionary, Fandom wikis, ArchWiki, Gentoo Wiki, or any self-hosted
     * instance), queries the wiki's real API (action=parse) for the
     * article's own content HTML instead of scraping the rendered page
     * (nav/sidebar/search-box chrome). Unlike preferLlmsTxt/
     * preferMarkdownVariant, this does not change `url` — it's the same
     * resource via a different retrieval mechanism, so the result still
     * goes through the normal Readability/metadata pipeline on the API's
     * (already much cleaner) HTML. Falls through unchanged when the URL
     * doesn't look like an article, or the site isn't MediaWiki-based.
     * Default: false — preserves the existing fetch contract exactly.
     */
    preferMediaWiki?: boolean;
    /**
     * When true and the URL is a github.com repo/issue/pull-request page,
     * queries GitHub's real REST API for structured data (repo metadata +
     * README, or issue/PR title/state/labels/body) instead of scraping
     * GitHub's JS-heavy rendered pages. Unauthenticated requests are limited
     * to 60/hour per IP (GitHub's own limit, verified directly) -- pass
     * githubToken, or set GITHUB_TOKEN/GH_TOKEN in the environment, to raise
     * this to 5,000/hour. `url` is unchanged (same resource, different
     * mechanism). Falls through unchanged for blob/wiki/other URL shapes,
     * non-github.com hosts, or any API failure (rate limit, 404, network).
     * Default: false — preserves the existing fetch contract exactly.
     */
    preferGitHub?: boolean;
    /** Explicit GitHub token for preferGitHub; falls back to GITHUB_TOKEN/GH_TOKEN env vars. Never logged. */
    githubToken?: string;
    /**
     * Pure response-content Strategies tried before Web Spider's built-in HTML
     * and textual extractors. First supporting extractor wins.
     */
    contentExtractors?: readonly ContentExtractor[];
    /**
     * Per-site/per-convention ContentSourceStrategies (see
     * ../sources/content-source.ts, docs/content-source-strategies.md), tried
     * in order before the legacy preferLlmsTxt/preferMarkdownVariant/
     * preferGitHub/preferMediaWiki flags below. The first strategy whose
     * `matches(url)` returns true AND whose `fetch()` returns a non-null
     * result wins; a miss falls through to the next strategy, then to the
     * legacy flags, then to a plain fetch — exactly like `contentExtractors`.
     * This is the extension point for adding a new site (Wikipedia, GitHub,
     * YouTube, or your own) without editing spider() itself: implement
     * ContentSourceStrategy and pass an instance here, or register it by name
     * via ../sources/registry.ts and resolve it with resolveContentSources().
     * Default: [] — preserves the existing fetch contract exactly.
     */
    contentSources?: readonly ContentSourceStrategy[];
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