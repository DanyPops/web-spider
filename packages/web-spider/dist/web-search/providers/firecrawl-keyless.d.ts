import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
/** Minimal Fetch-shaped transport seam for deterministic adapter tests. */
export type SearchTransport = (input: string, init?: RequestInit) => Promise<Response>;
export interface FirecrawlKeylessSearchOptions {
    transport?: SearchTransport;
    timeoutMs?: number;
    numResults?: number;
    timeRange?: SearchQuery["timeRange"];
    topic?: SearchQuery["topic"];
    siteFilter?: string;
}
/** Search Firecrawl's officially supported per-IP keyless fallback endpoint. */
export declare function firecrawlKeylessSearch(query: string, options?: FirecrawlKeylessSearchOptions): Promise<WebSearchResult[]>;
/** Keyless Firecrawl adapter implementing the existing search Strategy port. */
export declare class FirecrawlKeylessSearchEngine implements ISearchEngine {
    private readonly options;
    constructor(options?: Pick<FirecrawlKeylessSearchOptions, "transport" | "timeoutMs">);
    search(request: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=firecrawl-keyless.d.ts.map