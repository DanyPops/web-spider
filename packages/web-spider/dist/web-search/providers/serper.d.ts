import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface SerperSearchOptions {
    /** API key. Defaults to process.env.SERPER_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
    /** Restrict results to one domain. Serper scrapes Google's own SERP, so a `site:` operator in the query text works natively -- no structured param exists. */
    siteFilter?: string;
}
/**
 * Search the web via Serper.dev (Google-backed SERP API).
 * https://serper.dev/
 *
 * Response shape (organic[]/knowledgeGraph) verified directly against
 * serper.dev's own homepage sample response. Request contract (POST,
 * X-API-KEY header, {q} body) is long-standing, widely-documented public
 * convention -- not independently re-confirmed against a formal docs page
 * this session (their playground page is JS-rendered/cookie-walled).
 */
export declare function serperSearch(query: string, opts?: SerperSearchOptions): Promise<WebSearchResult[]>;
/** Serper.dev adapter implementing ISearchEngine. */
export declare class SerperSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=serper.d.ts.map