// ---------------------------------------------------------------------------
// Public API — what most consumers need
// ---------------------------------------------------------------------------
export { SpiderCache } from "./cache/cache.js";
export { canonicalizeUrl } from "./cache/cache-key.js";
export { crawl } from "./crawl/crawl.js";
export { PageGraph } from "./crawl/graph.js";
export { buildTree, navigateTree, queryTree } from "./extract/tree.js";
export { toLean } from "./extract/views.js";
export { FetchTransportError, isLikelyFetchTransportFailure, toFetchTransportError } from "./errors.js";
export { spider } from "./fetch/spider.js";
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking (not fuzzy-only). */
export { searchPages, searchPages as fuzzySearch } from "./search.js";
export { parseGitHubUrl, queryGitHub } from "./sources/github.js";
export { probeLlmsTxt } from "./sources/llms-txt.js";
export { deriveMarkdownVariantUrl, probeMarkdownVariant } from "./sources/markdown-suffix.js";
export { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "./sources/mediawiki.js";
export { braveLlmContextSearch, braveSearch, envKeyForEngine, exaSearch, isLikelyQuotaExceededError, isLikelyRateLimitError, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine, serpApiSearch, serperSearch, tavilySearch, tavilySearchForAnswer, webSearch, youComSearch, } from "./web-search/index.js";
/**
 * Retrieve a single chunk from a cached page by URL and chunk index.
 *
 * Avoids loading the full page markdown when an agent only needs one
 * specific chunk — e.g. to re-read a section after a highlights hit.
 *
 * Returns undefined when the URL is not cached, the index is out of range,
 * or the index is negative.
 *
 * @example
 * const chunk = getChunk(cache, "https://example.com/article", 3)
 * if (chunk) console.log(chunk.text)
 */
export function getChunk(cache, url, index) {
    if (index < 0)
        return undefined;
    return cache.get(url)?.chunks[index];
}
export { DiskCache } from "./cache/disk-cache.js";
export { createPlaywrightClient, PlaywrightHttpClient } from "./fetch/playwright.js";
export { createRobotsCache, RobotsCache } from "./fetch/robots.js";
export { createThrottle, DomainThrottle } from "./fetch/throttle.js";
export { fetchSitemapUrls } from "./sources/sitemap.js";
export { BraveLlmContextSearchEngine, BraveSearchEngine, CapabilityRoutedSearchEngine, defaultAnswerEngine, defaultSearchEngine, ExaSearchEngine, FallbackSearchEngine, InMemorySiteAvailabilityTracker, RoundRobinSearchEngine, SerpApiSearchEngine, SerperSearchEngine, SiteRoutedSearchEngine, TavilySearchEngine, YouComSearchEngine, } from "./web-search/index.js";
export { ingestToScribe, pagesToNDJSON, pageToRecords } from "./scribe-bridge.js";
// parse.ts, convert.ts, views.ts are internal implementation modules.
// They are NOT exported here — they are consumed only by spider.ts.
// If you need lower-level DOM or markdown utilities, import from the
// sub-modules directly (not covered by semver stability guarantees).
// ---------------------------------------------------------------------------
//# sourceMappingURL=index.js.map