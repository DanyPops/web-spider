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
    /**
     * Freshness filter. Maps SearchQuery.timeRange to Brave's parameter:
     *   "pd" = past day, "pw" = past week, "pm" = past month, "py" = past year.
     * Pass directly when bypassing the adapter, or set timeRange on SearchQuery.
     */
    freshness?: "pd" | "pw" | "pm" | "py";
}
export interface TavilySearchOptions {
    /** API key. Defaults to process.env.TAVILY_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 5. */
    numResults?: number;
    /** "basic" (1 credit) or "advanced" (2 credits). Default "basic". */
    depth?: "basic" | "advanced";
    /** Restrict results to content published within this window. */
    timeRange?: "day" | "week" | "month" | "year";
    /** Topic mode: "news" prioritises fresh news articles. */
    topic?: "news" | "general";
}
export type SearchEngine = "brave" | "tavily" | "exa" | "ddg";
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
export interface DdgSearchOptions {
    /**
     * Maximum results to return. DDG doesn't support a server-side count param;
     * this slices the client-side result list. Default: 10.
     */
    numResults?: number;
}
/**
 * Search via the DuckDuckGo Instant Answer API.
 * https://duckduckgo.com/api
 *
 * No API key required. Returns structured instant answers (Abstract,
 * Results, RelatedTopics) mapped to WebSearchResult[].
 *
 * Limitation: not a full web index — best for well-known entities and
 * unambiguous queries. Returns empty when DDG has no instant answer.
 */
export declare function ddgSearch(query: string, opts?: DdgSearchOptions): Promise<WebSearchResult[]>;
/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Falls through to the DDG Instant Answer API as a zero-cost
 * last resort — no key required.
 *
 * Prefer {@link defaultSearchEngine} + {@link FallbackSearchEngine} when
 * you need composable retry / fallback behaviour.
 */
export declare function webSearch(query: string, opts?: {
    engine?: SearchEngine;
    numResults?: number;
    timeRange?: "day" | "week" | "month" | "year";
    topic?: "news" | "general";
}): Promise<WebSearchResult[]>;
/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines (e.g. DDG).
 */
type EngineFactory = (key: string | undefined) => ISearchEngine;
/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export declare function registerSearchEngine(name: string, factory: EngineFactory): void;
/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export declare function resolveSearchEngine(name: string, key?: string | undefined): ISearchEngine;
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
/** DuckDuckGo Instant Answer adapter — no API key required. */
export declare class DdgSearchEngine implements ISearchEngine {
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
export interface FallbackSearchEngineOptions {
    /**
     * Treat an empty result set as a failure and try the next engine.
     * Default: true.
     */
    fallbackOnEmpty?: boolean;
    /**
     * Swallow a thrown error and try the next engine instead of propagating.
     * Default: true.
     */
    fallbackOnError?: boolean;
}
/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws.
 *
 * Because it implements ISearchEngine itself it is fully composable —
 * nest FallbackSearchEngines, wrap them in caches, inject stubs in tests.
 *
 * @example
 * // Tavily with DDG as zero-cost fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new DdgSearchEngine(),
 * ]);
 */
export declare class FallbackSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly fallbackOnEmpty;
    private readonly fallbackOnError;
    constructor(engines: ISearchEngine[], opts?: FallbackSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/**
 * Build a FallbackSearchEngine chain from environment variables.
 *
 * Priority order for keyed engines: Brave → Tavily → Exa.
 * DuckDuckGo is always appended as the zero-cost last resort.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export declare function defaultSearchEngine(): ISearchEngine;
//# sourceMappingURL=web-search.d.ts.map