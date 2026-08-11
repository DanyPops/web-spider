export type { SpiderCacheOptions } from "./cache/cache.js";
export { SpiderCache } from "./cache/cache.js";
export { canonicalizeUrl } from "./cache/cache-key.js";
export { buildTextFragmentUrl } from "./citation.js";
export type { CrawlBudget, CrawlBudgetState, CrawlStopReason, DefaultCrawlBudgetOptions } from "./crawl/budget.js";
export { DefaultCrawlBudget, MaxPagesBudget } from "./crawl/budget.js";
export type { PageClassification, PageClassifier, PageType } from "./crawl/classifier.js";
export { DefaultPageClassifier, HeuristicPageClassifier, renderLinkList } from "./crawl/classifier.js";
export type { CrawlOptions, CrawlResult } from "./crawl/crawl.js";
export { crawl } from "./crawl/crawl.js";
export type { LinkScoreContext, LinkScorer } from "./crawl/frontier.js";
export { HeuristicLinkScorer, InsertionOrderLinkScorer, orderFrontier } from "./crawl/frontier.js";
export type { PageEdge, PageGraphSnapshot, PageNode } from "./crawl/graph.js";
export { PageGraph } from "./crawl/graph.js";
export type { FetchTransportErrorOptions, FetchTransportFailureKind } from "./errors.js";
export { FetchTransportError, isLikelyFetchTransportFailure, toFetchTransportError } from "./errors.js";
export type { QueryTreeOptions } from "./extract/tree.js";
export { buildTree, navigateTree, queryTree } from "./extract/tree.js";
export { toLean } from "./extract/views.js";
export type { ContentExtractionOptions, ContentExtractionResult, ContentExtractor, ExtractedImageCandidate, ExtractedPage, FetchedResource, TreePage, } from "./fetch/content-extractor.js";
export { extractFetchedResource } from "./fetch/content-extractor.js";
export type { PdfExtractedPage, PdfExtraction, PdfExtractor, PdfMetadata, PdfOutlineEntry, PdfPageRange, } from "./fetch/pdf-extractor.js";
export { PdfContentExtractor, PdfExtractionError, UnpdfPdfExtractor } from "./fetch/pdf-extractor.js";
export type { OcrEngine, OcrResult, PdfPageImage, PdfPageRasterizer } from "./fetch/pdf-ocr.js";
export { OcrFallbackPdfExtractor, TesseractOcrEngine, UnpdfPageRasterizer } from "./fetch/pdf-ocr.js";
export type { SpiderOptions } from "./fetch/spider.js";
export { spider } from "./fetch/spider.js";
export type { FuzzySearchOptions, SearchHit } from "./search.js";
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking (not fuzzy-only). */
export { searchPages, searchPages as fuzzySearch } from "./search.js";
export type { ContentSourceRequest, ContentSourceResult, ContentSourceStrategy } from "./sources/content-source.js";
export type { GitHubQueryResult, GitHubResourceKind, GitHubStrategyOptions } from "./sources/github.js";
export { githubContentSource, parseGitHubUrl, queryGitHub } from "./sources/github.js";
export type { LlmsTxtProbeResult, LlmsTxtVariant, ProbeLlmsTxtOptions } from "./sources/llms-txt.js";
export { llmsTxtContentSource, probeLlmsTxt } from "./sources/llms-txt.js";
export type { MarkdownVariantProbeResult, ProbeMarkdownVariantOptions } from "./sources/markdown-suffix.js";
export { deriveMarkdownVariantUrl, markdownSuffixContentSource, probeMarkdownVariant } from "./sources/markdown-suffix.js";
export type { MediaWikiPageResult, MediaWikiProbeOptions, MediaWikiSiteInfo } from "./sources/mediawiki.js";
export { detectMediaWiki, extractWikiPageTitle, mediaWikiContentSource, queryMediaWikiPage } from "./sources/mediawiki.js";
export type { ContentSourceFactory } from "./sources/registry.js";
export { buildRegisteredContentSources, listRegisteredContentSources, registerContentSource, resolveContentSources, } from "./sources/registry.js";
export type { YouTubeOembedResult, YouTubeProbeOptions } from "./sources/youtube.js";
export { parseYouTubeVideoId, queryYouTubeOembed, youtubeContentSource } from "./sources/youtube.js";
export type { Chunk, ChunkType, ContentQualityWarning, DOMNode, ImageRef, LeanLink, LeanPage, Link, PageView, PdfPageInfo, SpideredPage, TreeHit, } from "./types.js";
export type { BraveLlmContextSearchOptions, BraveSearchOptions, DefaultAnswerEngineOptions, DefaultSearchEngineOptions, EngineFailureReason, EngineUsage, ExaSearchOptions, FallbackSearchEngineOptions, FirecrawlKeylessSearchOptions, InMemorySiteAvailabilityTrackerOptions, KeyCooldownPolicy, KeyFailureKind, NamedSearchEngine, RateLimitPredicate, RotatingKeySearchEngineOptions, RoundRobinSearchEngineOptions, SearchEngine, SearchTransport, SerpApiSearchOptions, SerperSearchOptions, SiteRoutedSearchEngineOptions, TavilyAnswerSearchOptions, TavilySearchOptions, WebSearchOptions, WebSearchResult, YouComSearchOptions, } from "./web-search/index.js";
export { braveLlmContextSearch, braveSearch, createDefaultKeyCooldownPolicy, envKeyForEngine, exaSearch, firecrawlKeylessSearch, isLikelyInvalidKeyError, isLikelyQuotaExceededError, isLikelyRateLimitError, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine, serpApiSearch, serperSearch, tavilySearch, tavilySearchForAnswer, webSearch, youComSearch, } from "./web-search/index.js";
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
export { createRobotsCache, RobotsCache } from "./fetch/robots.js";
export type { ThrottleOptions } from "./fetch/throttle.js";
export { createThrottle, DomainThrottle } from "./fetch/throttle.js";
export type { AnswerResult, HttpRequest, HttpResponse, IAnswerSearchEngine, ICache, IHttpClient, IRobotsChecker, ISearchEngine, IThrottle, RobotsResult, SearchQuery, SiteAvailabilityTracker, } from "./ports.js";
export { fetchSitemapUrls } from "./sources/sitemap.js";
export { BraveLlmContextSearchEngine, BraveSearchEngine, CapabilityRoutedSearchEngine, defaultAnswerEngine, defaultSearchEngine, ExaSearchEngine, FallbackSearchEngine, FirecrawlKeylessSearchEngine, InMemorySiteAvailabilityTracker, RotatingKeySearchEngine, RoundRobinSearchEngine, SerpApiSearchEngine, SerperSearchEngine, SiteRoutedSearchEngine, TavilySearchEngine, YouComSearchEngine, } from "./web-search/index.js";
export type { NDJSONRecord } from "./scribe-bridge.js";
export { ingestToScribe, pagesToNDJSON, pageToRecords } from "./scribe-bridge.js";
//# sourceMappingURL=index.d.ts.map