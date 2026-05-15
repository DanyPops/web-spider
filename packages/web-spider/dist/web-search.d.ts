/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
export type { WebSearchResult } from "./ports.js";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "./ports.js";
export interface BraveSearchOptions {
    /** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY. */
    apiKey?: string;
    /** Number of results (1–20). Default 10. */
    numResults?: number;
    /** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
    country?: string;
}
export interface TavilySearchOptions {
    /** API key. Defaults to process.env.TAVILY_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 5. */
    numResults?: number;
    /** "basic" (1 credit) or "advanced" (2 credits). Default "basic". */
    depth?: "basic" | "advanced";
}
export type SearchEngine = "brave" | "tavily" | "exa";
export interface ExaSearchOptions {
    /** API key. Defaults to process.env.EXA_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
    /**
     * Search type.
     * "auto"   — Exa decides keyword vs neural (default).
     * "neural" — embedding-based semantic search.
     * "keyword" — traditional keyword search.
     */
    type?: "auto" | "neural" | "keyword";
}
/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export declare function exaSearch(query: string, opts?: ExaSearchOptions): Promise<WebSearchResult[]>;
/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export declare function braveSearch(query: string, opts?: BraveSearchOptions): Promise<WebSearchResult[]>;
/**
 * Search the web via the Tavily API.
 * https://docs.tavily.com/docs/rest-api/api-reference
 */
export declare function tavilySearch(query: string, opts?: TavilySearchOptions): Promise<WebSearchResult[]>;
/**
 * Search using whichever engine has an API key available.
 * Tries Brave first, then Tavily, throws if neither is configured.
 */
export declare function webSearch(query: string, opts?: {
    engine?: SearchEngine;
    numResults?: number;
}): Promise<WebSearchResult[]>;
/** Brave Search adapter implementing ISearchEngine. */
export declare class BraveSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly country?;
    constructor(apiKey: string, country?: string | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** Tavily adapter implementing ISearchEngine. */
export declare class TavilySearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** Exa adapter implementing ISearchEngine. */
export declare class ExaSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/**
 * Build an ISearchEngine from environment variables.
 * Priority: Brave → Tavily → Exa.
 */
export declare function defaultSearchEngine(): ISearchEngine;
//# sourceMappingURL=web-search.d.ts.map