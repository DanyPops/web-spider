import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface YouComSearchOptions {
    /** API key. Defaults to process.env.YOU_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
    /** Restrict results to one domain. Maps to You.com's own `include_domains` query param (comma-separated on the wire; we only ever send one entry). */
    siteFilter?: string;
}
/**
 * Search the web via the You.com Search API (independent index, AI-first
 * response format). https://you.com/docs/guides/search
 *
 * Each web result can carry multiple pre-ranked `snippets` -- richer than
 * the single-description shape most other engines return, surfaced via
 * {@link WebSearchResult.highlights}.
 */
export declare function youComSearch(query: string, opts?: YouComSearchOptions): Promise<WebSearchResult[]>;
/** You.com adapter implementing ISearchEngine. */
export declare class YouComSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=you.d.ts.map