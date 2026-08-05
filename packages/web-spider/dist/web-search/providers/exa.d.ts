import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface ExaSearchOptions {
    /** API key. Defaults to process.env.EXA_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
    /**
     * Search type -- a latency/quality dial, per Exa's own OpenAPI spec
     * (exa-labs/openapi-spec): "neural" | "fast" | "auto" | "deep" |
     * "deep-reasoning" | "instant". "keyword" is no longer a valid value --
     * dropped, not aliased, since sending it now gets a 400 from Exa rather
     * than silently degrading.
     *
     * "auto"           — Exa decides keyword vs neural (default).
     * "neural"         — embeddings-based semantic search.
     * "fast"           — streamlined versions of the search models, ~450ms.
     * "instant"        — lowest latency, optimised for real-time apps, ~250ms.
     * "deep"           — light deep search: multi-step, structured output.
     * "deep-reasoning" — base deep search, more reasoning, 12-40s.
     */
    type?: "auto" | "neural" | "fast" | "instant" | "deep" | "deep-reasoning";
    /** Restrict results to one domain. Maps to Exa's own `includeDomains` array param (accepts domains, path prefixes, and subdomain wildcards per Exa's docs -- we only ever send one entry). */
    siteFilter?: string;
    /** Include each result's full extracted page text in {@link WebSearchResult.content} (Exa's own `contents.text`). Off by default -- costs more and inflates payload size, matching Tavily's includeRawContent. */
    includeText?: boolean;
    /** Called once with this call's own dollar cost, when Exa reports one (only non-zero costs are included in its response). */
    onUsage?: (usage: EngineUsage) => void;
}
/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export declare function exaSearch(query: string, opts?: ExaSearchOptions): Promise<WebSearchResult[]>;
/** Exa adapter implementing ISearchEngine. */
export declare class ExaSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=exa.d.ts.map