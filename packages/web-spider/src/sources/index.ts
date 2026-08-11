/**
 * Content source strategies -- site-specific probes (GitHub, MediaWiki,
 * llms.txt, markdown-suffix, YouTube) that `spider()` tries before falling
 * back to generic HTML extraction, plus the registry those strategies are
 * looked up through. Mirrors web-search/index.ts's own barrel shape: each
 * strategy lives in its own file, this is the package's public entrypoint
 * for the group.
 *
 * `registerContentSource`/`resolveContentSources`/etc. live in registry.ts,
 * which self-registers every built-in strategy at import time -- that file
 * is declared in package.json's "sideEffects" array for exactly that reason.
 */

export type { ContentSourceRequest, ContentSourceResult, ContentSourceStrategy } from "./content-source.js";
export type { GitHubQueryResult, GitHubResourceKind, GitHubStrategyOptions } from "./github.js";
export { githubContentSource, parseGitHubUrl, queryGitHub } from "./github.js";
export type { LlmsTxtProbeResult, LlmsTxtVariant, ProbeLlmsTxtOptions } from "./llms-txt.js";
export { llmsTxtContentSource, probeLlmsTxt } from "./llms-txt.js";
export type { MarkdownVariantProbeResult, ProbeMarkdownVariantOptions } from "./markdown-suffix.js";
export { deriveMarkdownVariantUrl, markdownSuffixContentSource, probeMarkdownVariant } from "./markdown-suffix.js";
export type { MediaWikiPageResult, MediaWikiProbeOptions, MediaWikiSiteInfo } from "./mediawiki.js";
export { detectMediaWiki, extractWikiPageTitle, mediaWikiContentSource, queryMediaWikiPage } from "./mediawiki.js";
export type { ContentSourceFactory } from "./registry.js";
export {
	buildRegisteredContentSources,
	listRegisteredContentSources,
	registerContentSource,
	resolveContentSources,
} from "./registry.js";
export { fetchSitemapUrls } from "./sitemap.js";
export type { YouTubeOembedResult, YouTubeProbeOptions } from "./youtube.js";
export { parseYouTubeVideoId, queryYouTubeOembed, youtubeContentSource } from "./youtube.js";
