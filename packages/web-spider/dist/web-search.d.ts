/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
export interface WebSearchResult {
    url: string;
    title: string;
    /** Short description / snippet from the search engine. */
    snippet: string;
    /** ISO-8601 or human-readable date, if the engine returned one. */
    publishedAt?: string;
}
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
export type SearchEngine = "brave" | "tavily";
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
//# sourceMappingURL=web-search.d.ts.map