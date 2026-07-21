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
export type { Chunk, ChunkType, DOMNode, ImageRef, LeanLink, LeanPage, Link, PageView, SpideredPage, TreeHit } from "./types.js";
export { toLean } from "./views.js";
export type { BraveSearchOptions, DdgSearchOptions, ExaSearchOptions, FallbackSearchEngineOptions, SearchEngine, TavilySearchOptions, WebSearchResult } from "./web-search.js";
export { braveSearch, ddgSearch, exaSearch, registerSearchEngine, resolveSearchEngine, tavilySearch, webSearch } from "./web-search.js";
import type { ICache } from "./ports.js";
import type { Chunk, SpideredPage } from "./types.js";
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
export declare function getChunk(cache: ICache<string, SpideredPage>, url: string, index: number): Chunk | undefined;
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
export type { NDJSONRecord } from "./scribe-bridge.js";
export { pageToRecords, pagesToNDJSON, ingestToScribe } from "./scribe-bridge.js";
//# sourceMappingURL=index.d.ts.map