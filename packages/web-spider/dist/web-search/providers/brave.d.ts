import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface BraveSearchOptions {
    /** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY. */
    apiKey?: string;
    /** Number of results (1–20). Default 10. */
    numResults?: number;
    /** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
    country?: string;
    /**
     * Freshness filter. Maps SearchQuery.timeRange to Brave's parameter:
     *   "pd" = past day, "pw" = past week, "pm" = past month, "py" = past year.
     * Pass directly when bypassing the adapter, or set timeRange on SearchQuery.
     */
    freshness?: "pd" | "pw" | "pm" | "py";
    /** Restrict results to one domain. Brave has no structured domain-filter param -- appended as a `site:` operator in the query text instead. */
    siteFilter?: string;
    /**
     * Include up to 5 extra excerpts per result (Brave's own `extra_snippets`
     * param), surfaced in {@link WebSearchResult.highlights}. Off by default --
     * costs nothing extra per Brave's docs, but not every caller wants the
     * larger payload.
     */
    extraSnippets?: boolean;
    /**
     * Called once with any rate-limit/quota-shaped response headers Brave sent.
     * Confirmed against Brave's own docs: X-RateLimit-Limit/-Policy/-Remaining/
     * -Reset are real, documented response headers.
     */
    onUsage?: (usage: EngineUsage) => void;
}
/** Maps the canonical timeRange string to Brave's freshness parameter. Reused by the Brave LLM Context adapter, which shares the same freshness vocabulary. */
export declare const BRAVE_FRESHNESS: Record<string, "pd" | "pw" | "pm" | "py">;
/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export declare function braveSearch(query: string, opts?: BraveSearchOptions): Promise<WebSearchResult[]>;
/** Brave Search adapter implementing ISearchEngine. */
export declare class BraveSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly country?;
    private readonly onUsage?;
    private readonly extraSnippets;
    constructor(apiKey: string, country?: string | undefined, onUsage?: ((usage: EngineUsage) => void) | undefined, extraSnippets?: boolean);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=brave.d.ts.map