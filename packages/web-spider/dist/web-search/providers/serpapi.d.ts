import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface SerpApiSearchOptions {
    /** API key. Defaults to process.env.SERPAPI_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
    /** Restrict results to one domain. SerpApi scrapes real Google SERPs, so a `site:` operator in the query text works natively -- no structured param exists. */
    siteFilter?: string;
}
/**
 * Search the web via SerpApi (scraped, real Google SERPs -- not a curated
 * index). https://serpapi.com/search-api
 *
 * Request/response shape verified directly against SerpApi's own docs:
 * GET /search.json with engine/q/api_key/num params, organic_results[] in
 * the response. SerpApi can also return HTTP 200 with a top-level `error`
 * field for some failures (documented behavior, e.g. an exhausted plan) --
 * checked explicitly, not just res.ok.
 */
export declare function serpApiSearch(query: string, opts?: SerpApiSearchOptions): Promise<WebSearchResult[]>;
/** SerpApi adapter implementing ISearchEngine. */
export declare class SerpApiSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=serpapi.d.ts.map