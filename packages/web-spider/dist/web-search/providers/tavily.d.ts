import type { AnswerResult, EngineUsage, IAnswerSearchEngine, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
export interface TavilySearchOptions {
    /** API key. Defaults to process.env.TAVILY_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 5. */
    numResults?: number;
    /**
     * Latency/relevance tradeoff. `basic`/`advanced` return one NLP summary
     * per URL; `fast`/`ultra-fast` return multiple semantically relevant
     * chunks per URL instead (chunk count set separately by Tavily, not
     * currently exposed here). Cost: basic/fast/ultra-fast 1 credit,
     * advanced 2 credits. Default "basic".
     */
    depth?: "basic" | "advanced" | "fast" | "ultra-fast";
    /** Restrict results to content published within this window. */
    timeRange?: "day" | "week" | "month" | "year";
    /** Topic mode: "news" prioritises fresh news articles, "finance" prioritises financial sources. */
    topic?: "news" | "general" | "finance";
    /** Restrict results to one domain. Maps to Tavily's own `include_domains` array param (we only ever send one entry). */
    siteFilter?: string;
    /** Domains to exclude from results. Maps to Tavily's own `exclude_domains` array param (max 150 domains). */
    excludeDomains?: string[];
    /** Include each result's full cleaned/parsed page content in {@link WebSearchResult.content}. Off by default -- costs more and inflates payload size (Tavily's own `include_raw_content`). */
    includeRawContent?: boolean;
    /** Include a favicon URL for each result (Tavily's own `include_favicon`). Off by default. */
    includeFavicon?: boolean;
    /** Boost results from this country (lowercase full name, e.g. "united states") -- Tavily's own `country` param. Only honoured by Tavily when topic is "general". */
    country?: string;
    /** Only return results published on/after this date (YYYY-MM-DD). Maps to Tavily's own `start_date`. */
    startDate?: string;
    /** Only return results published on/before this date (YYYY-MM-DD). Maps to Tavily's own `end_date`. */
    endDate?: string;
    /** Called once with this call's own credit cost, when Tavily reports one. */
    onUsage?: (usage: EngineUsage) => void;
}
/**
 * Search the web via the Tavily API.
 * https://docs.tavily.com/docs/rest-api/api-reference
 */
export declare function tavilySearch(query: string, opts?: TavilySearchOptions): Promise<WebSearchResult[]>;
export interface TavilyAnswerSearchOptions extends Omit<TavilySearchOptions, "includeRawContent"> {
    /** "basic" (quick) or "advanced" (more detailed) answer synthesis. Default "basic", matching Tavily's own default. */
    answerDepth?: "basic" | "advanced";
}
/**
 * Search via Tavily with `include_answer` enabled -- returns a synthesized,
 * LLM-generated answer plus the sources it was built from, instead of a
 * plain results list. Reference implementation of the answer-first port
 * ({@link IAnswerSearchEngine}): reuses Tavily's existing search endpoint
 * and API key rather than requiring a new vendor.
 */
export declare function tavilySearchForAnswer(query: string, opts?: TavilyAnswerSearchOptions): Promise<AnswerResult>;
/** Tavily adapter implementing ISearchEngine and IAnswerSearchEngine (reference implementation of the answer-first port, via Tavily's own include_answer). */
export declare class TavilySearchEngine implements ISearchEngine, IAnswerSearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
    searchForAnswer(req: SearchQuery): Promise<AnswerResult>;
}
//# sourceMappingURL=tavily.d.ts.map