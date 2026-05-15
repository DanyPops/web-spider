// ---------------------------------------------------------------------------
// Public API — what most consumers need
// ---------------------------------------------------------------------------

export type { BatchOptions } from "./batch.js";
export { batchSpider } from "./batch.js";
export type { SpiderCacheOptions } from "./cache.js";
export { SpiderCache } from "./cache.js";
export type { CrawlOptions, CrawlResult } from "./crawl.js";
export { crawl } from "./crawl.js";
export type { PageEdge, PageGraphSnapshot, PageNode } from "./graph.js";
export { PageGraph } from "./graph.js";
export type { FuzzySearchOptions, SearchHit } from "./search.js";
export { searchPages } from "./search.js";
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking (not fuzzy-only). */
export { searchPages as fuzzySearch } from "./search.js";
export type { SpiderOptions, TreePage } from "./spider.js";
export { spider } from "./spider.js";
export type { QueryTreeOptions } from "./tree.js";
export { buildTree, navigateTree, queryTree } from "./tree.js";
export type { Chunk, ChunkType, DOMNode, LeanLink, LeanPage, Link, PageView, SpideredPage, TreeHit } from "./types.js";
export { toLean } from "./views.js";
export type { BraveSearchOptions, DdgSearchOptions, ExaSearchOptions, FallbackSearchEngineOptions, SearchEngine, TavilySearchOptions, WebSearchResult } from "./web-search.js";
export { braveSearch, ddgSearch, exaSearch, tavilySearch, webSearch } from "./web-search.js";

// ---------------------------------------------------------------------------
// Extension / DI — port interfaces and their concrete adapters.
// Import these when you need to inject custom implementations.
// ---------------------------------------------------------------------------

export type { HttpRequest, HttpResponse, ICache, IHttpClient, IRobotsChecker, ISearchEngine, IThrottle, RobotsResult, SearchQuery } from "./ports.js";
export type { DiskCacheOptions } from "./disk-cache.js";
export { DiskCache } from "./disk-cache.js";
export type { PlaywrightClientOptions } from "./playwright.js";
export { PlaywrightHttpClient, createPlaywrightClient } from "./playwright.js";
export { RobotsCache, createRobotsCache } from "./robots.js";
export { fetchSitemapUrls } from "./sitemap.js";
export type { ThrottleOptions } from "./throttle.js";
export { DomainThrottle, createThrottle } from "./throttle.js";
export { BraveSearchEngine, DdgSearchEngine, ExaSearchEngine, FallbackSearchEngine, TavilySearchEngine, defaultSearchEngine } from "./web-search.js";

// ---------------------------------------------------------------------------
// parse.ts, convert.ts, views.ts are internal implementation modules.
// They are NOT exported here — they are consumed only by spider.ts.
// If you need lower-level DOM or markdown utilities, import from the
// sub-modules directly (not covered by semver stability guarantees).
// ---------------------------------------------------------------------------
