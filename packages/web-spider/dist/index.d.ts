export type { SpiderCacheOptions } from "./cache/cache.js";
export { SpiderCache } from "./cache/cache.js";
export { canonicalizeUrl } from "./cache/cache-key.js";
export type { CrawlOptions, CrawlResult } from "./crawl/crawl.js";
export { crawl } from "./crawl/crawl.js";
export type { PageEdge, PageGraphSnapshot, PageNode } from "./crawl/graph.js";
export { PageGraph } from "./crawl/graph.js";
export type { QueryTreeOptions } from "./extract/tree.js";
export { buildTree, navigateTree, queryTree } from "./extract/tree.js";
export { toLean } from "./extract/views.js";
export type { SpiderOptions, TreePage } from "./fetch/spider.js";
export { spider } from "./fetch/spider.js";
export type { FuzzySearchOptions, SearchHit } from "./search.js";
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking (not fuzzy-only). */
export { searchPages, searchPages as fuzzySearch } from "./search.js";
export type { GitHubQueryResult, GitHubResourceKind, GitHubStrategyOptions } from "./sources/github.js";
export { parseGitHubUrl, queryGitHub } from "./sources/github.js";
export type { LlmsTxtProbeResult, LlmsTxtVariant, ProbeLlmsTxtOptions } from "./sources/llms-txt.js";
export { probeLlmsTxt } from "./sources/llms-txt.js";
export type { MarkdownVariantProbeResult, ProbeMarkdownVariantOptions } from "./sources/markdown-suffix.js";
export { deriveMarkdownVariantUrl, probeMarkdownVariant } from "./sources/markdown-suffix.js";
export type { MediaWikiPageResult, MediaWikiProbeOptions, MediaWikiSiteInfo } from "./sources/mediawiki.js";
export { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "./sources/mediawiki.js";
export type { Chunk, ChunkType, DOMNode, ImageRef, LeanLink, LeanPage, Link, PageView, SpideredPage, TreeHit } from "./types.js";
export type { BraveLlmContextSearchOptions, BraveSearchOptions, DefaultAnswerEngineOptions, DefaultSearchEngineOptions, EngineFailureReason, EngineUsage, ExaSearchOptions, FallbackSearchEngineOptions, InMemorySiteAvailabilityTrackerOptions, NamedSearchEngine, RateLimitPredicate, RoundRobinSearchEngineOptions, SearchEngine, SerpApiSearchOptions, SerperSearchOptions, SiteRoutedSearchEngineOptions, TavilyAnswerSearchOptions, TavilySearchOptions, WebSearchOptions, WebSearchResult, YouComSearchOptions, } from "./web-search/index.js";
export { braveLlmContextSearch, braveSearch, envKeyForEngine, exaSearch, isLikelyQuotaExceededError, isLikelyRateLimitError, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine, serpApiSearch, serperSearch, tavilySearch, tavilySearchForAnswer, webSearch, youComSearch, } from "./web-search/index.js";
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
export type { DiskCacheOptions } from "./cache/disk-cache.js";
export { DiskCache } from "./cache/disk-cache.js";
export type { PlaywrightClientOptions } from "./fetch/playwright.js";
export { createPlaywrightClient, PlaywrightHttpClient } from "./fetch/playwright.js";
export type { AnswerResult, HttpRequest, HttpResponse, IAnswerSearchEngine, ICache, IHttpClient, IRobotsChecker, ISearchEngine, IThrottle, RobotsResult, SearchQuery, SiteAvailabilityTracker, } from "./ports.js";
export { createRobotsCache, RobotsCache } from "./fetch/robots.js";
export { fetchSitemapUrls } from "./sources/sitemap.js";
export type { ThrottleOptions } from "./fetch/throttle.js";
export { createThrottle, DomainThrottle } from "./fetch/throttle.js";
export { BraveLlmContextSearchEngine, BraveSearchEngine, CapabilityRoutedSearchEngine, defaultAnswerEngine, defaultSearchEngine, ExaSearchEngine, FallbackSearchEngine, InMemorySiteAvailabilityTracker, RoundRobinSearchEngine, SerpApiSearchEngine, SerperSearchEngine, SiteRoutedSearchEngine, TavilySearchEngine, YouComSearchEngine, } from "./web-search/index.js";
export type { NDJSONRecord } from "./scribe-bridge.js";
export { ingestToScribe, pagesToNDJSON, pageToRecords } from "./scribe-bridge.js";
//# sourceMappingURL=index.d.ts.map