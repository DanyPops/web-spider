import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface BraveLlmContextSearchOptions {
    /** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY -- same subscription token as classic Brave web search. */
    apiKey?: string;
    /** Number of URLs to return (1-50). Maps to both Brave's own `count` (candidate pool) and `maximum_number_of_urls` (response cap) -- one dial instead of two, since a caller asking for N results has no reason to reason about both separately. Default 20 (Brave's own default) when omitted. */
    numResults?: number;
    /** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
    country?: string;
    /** Freshness filter -- same pd/pw/pm/py values as classic Brave search. */
    freshness?: "pd" | "pw" | "pm" | "py";
    /** Restrict results to one domain. No native domain-filter param on this endpoint -- appended as a `site:` operator, same as classic Brave. */
    siteFilter?: string;
    /** Relevance-filtering aggressiveness. Default "balanced" (Brave's own default) when omitted. */
    contextThresholdMode?: "strict" | "balanced" | "lenient" | "disabled";
    /** Maximum tokens per URL (512-8192, Brave's own default 4096). Raised when honouring {@link SearchQuery.wantFullContent} -- this endpoint has no literal "full page content" toggle, so a larger per-URL token budget is the closest fit for that intent. */
    maxTokensPerUrl?: number;
    /** Called once with any rate-limit/quota-shaped response headers Brave sent -- same convention as {@link import("./brave.js").BraveSearchOptions.onUsage}. */
    onUsage?: (usage: EngineUsage) => void;
}
/**
 * Search the web via Brave's LLM Context API -- pre-extracted, chunked page
 * content purpose-built for AI agents/RAG, distinct from {@link import("./brave.js").braveSearch}'s
 * classic SERP-shaped endpoint.
 * https://api-dashboard.search.brave.com/documentation/services/llm-context
 */
export declare function braveLlmContextSearch(query: string, opts?: BraveLlmContextSearchOptions): Promise<WebSearchResult[]>;
/**
 * Brave LLM Context adapter implementing ISearchEngine -- distinct from
 * {@link import("./brave.js").BraveSearchEngine}, which hits Brave's classic SERP endpoint.
 * Registered under "brave-llm", not folded into "brave": both read the same
 * BRAVE_SEARCH_API_KEY subscription token, so a caller opts in explicitly
 * (resolveSearchEngine/webSearch({engine: "brave-llm"})) instead of this
 * variant silently doubling Brave's share of defaultSearchEngine's
 * auto-detected round-robin rotation for every existing BRAVE_SEARCH_API_KEY
 * setup.
 */
export declare class BraveLlmContextSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=brave-llm.d.ts.map