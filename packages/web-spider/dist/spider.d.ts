import type { DOMNode, LeanPage, SpideredPage } from "./types.js";
export interface SpiderOptions {
    /**
     * ms before aborting the fetch (default 10 000).
     * Example: `{ timeoutMs: 5000 }` for aggressive timeouts on known-fast sites.
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
     * Equivalent to Jina Reader's X-Target-Selector.
     * Example: "article", ".main-content", "#post-body"
     */
    rootSelector?: string;
    /**
     * Comma-separated CSS selectors whose matched elements are removed before
     * extraction. Applied before Readability, so excluded content never reaches
     * the chunks or markdown.
     * Equivalent to Jina Reader's X-Remove-Selector.
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
}
/**
 * Spider a single URL and return a fully structured SpideredPage.
 *
 * Pass `view: "lean"` to skip chunking and markdown conversion — returns a
 * LeanPage with only identity, metadata, and the heading/link outline.
 * Significantly faster (~3×) and uses far fewer tokens in agent context.
 *
 * Errors are returned as thrown exceptions with a descriptive message rather
 * than crashing silently. Common cases:
 * - Non-HTTP URLs throw immediately with a clear message.
 * - HTTP errors include the status code.
 * - JS-rendered pages (wordCount === 0) include a hint.
 * - Timeouts include the configured limit.
 *
 * @example
 * // Full page — chunks, markdown, all metadata
 * const page = await spider("https://example.com")
 *
 * @example
 * // Lean overview — no body text, ideal for navigation decisions
 * const lean = await spider("https://example.com", { view: "lean" })
 */
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