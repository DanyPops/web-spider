// ---------------------------------------------------------------------------
// Public API — what most consumers need
// ---------------------------------------------------------------------------
export { SpiderCache } from "./cache.js";
export { crawl } from "./crawl.js";
export { PageGraph } from "./graph.js";
export { searchPages } from "./search.js";
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking (not fuzzy-only). */
export { searchPages as fuzzySearch } from "./search.js";
export { spider } from "./spider.js";
export { buildTree, navigateTree, queryTree } from "./tree.js";
export { toLean } from "./views.js";
export { braveSearch, ddgSearch, exaSearch, registerSearchEngine, resolveSearchEngine, tavilySearch, webSearch } from "./web-search.js";
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
export { DiskCache } from "./disk-cache.js";
export { PlaywrightHttpClient, createPlaywrightClient } from "./playwright.js";
export { RobotsCache, createRobotsCache } from "./robots.js";
export { fetchSitemapUrls } from "./sitemap.js";
export { DomainThrottle, createThrottle } from "./throttle.js";
export { BraveSearchEngine, DdgSearchEngine, ExaSearchEngine, FallbackSearchEngine, TavilySearchEngine, defaultSearchEngine } from "./web-search.js";
export { pageToRecords, pagesToNDJSON, ingestToScribe } from "./scribe-bridge.js";
// parse.ts, convert.ts, views.ts are internal implementation modules.
// They are NOT exported here — they are consumed only by spider.ts.
// If you need lower-level DOM or markdown utilities, import from the
// sub-modules directly (not covered by semver stability guarantees).
// ---------------------------------------------------------------------------
//# sourceMappingURL=index.js.map