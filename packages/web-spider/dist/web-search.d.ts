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
export type SearchEngine = "brave" | "tavily" | "exa" | "serper" | "serpapi" | "ddg";
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
export interface SerperSearchOptions {
    /** API key. Defaults to process.env.SERPER_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
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
export interface SerpApiSearchOptions {
    /** API key. Defaults to process.env.SERPAPI_API_KEY. */
    apiKey?: string;
    /** Number of results. Default 10. */
    numResults?: number;
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
/** Serper.dev adapter implementing ISearchEngine. */
export declare class SerperSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** SerpApi adapter implementing ISearchEngine. */
export declare class SerpApiSearchEngine implements ISearchEngine {
    private readonly apiKey;
    constructor(apiKey: string);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** DuckDuckGo Instant Answer adapter — no API key required. */
export declare class DdgSearchEngine implements ISearchEngine {
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** True for a rate-limit/quota response worth cooling down rather than retrying immediately: standard 429, Tavily's non-standard 432, and common quota-shaped message text. */
export declare function isLikelyRateLimitError(error: unknown): boolean;
export type RateLimitPredicate = (error: unknown) => boolean;
/** "error": the engine's search() call itself threw. "cooldown": skipped without even calling it, because a recent rate-limit failure hasn't cleared yet. */
export type EngineFailureReason = "error" | "cooldown";
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
    /** How long (ms) to skip an engine after a rate-limit-shaped failure, so an exhausted quota isn't retried on every call. Default 10 minutes. 0 disables cooldown. */
    cooldownMs?: number;
    /** Defaults to isLikelyRateLimitError. */
    isRateLimitError?: RateLimitPredicate;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
    /** Called once per engine failure, including a cooldown skip -- e.g. wire to a logger. Not called for a genuine empty result. Index only, not a name -- a caller that wants names maps it itself. */
    onEngineFailure?: (engineIndex: number, error: unknown, reason: EngineFailureReason) => void;
}
/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws, and
 * skipping an engine for a cooldown window after a rate-limit-shaped
 * failure rather than retrying an already-exhausted quota on every call.
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
    private readonly cooldownMs;
    private readonly isRateLimitError;
    private readonly now;
    private readonly onEngineFailure;
    /** engines[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
    private readonly cooldownUntil;
    constructor(engines: ISearchEngine[], opts?: FallbackSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
export interface RoundRobinSearchEngineOptions {
    /** How long (ms) to skip an engine's rotation slot after a rate-limit-shaped failure. Default 10 minutes. 0 disables cooldown. */
    cooldownMs?: number;
    /** Defaults to isLikelyRateLimitError. */
    isRateLimitError?: RateLimitPredicate;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
    /** Called once per engine failure, including a cooldown skip. Index only, not a name (mirrors FallbackSearchEngineOptions.onEngineFailure). */
    onEngineFailure?: (engineIndex: number, error: unknown, reason: EngineFailureReason) => void;
}
/**
 * A composite ISearchEngine that spreads calls evenly across equal-tier
 * engines instead of always hitting the first one -- unlike
 * FallbackSearchEngine's fixed priority order (best engine first, worse
 * ones as fallback), round-robin treats every engine as an interchangeable
 * peer and cycles through them one call at a time.
 *
 * Tracks cooldown per engine (not per composite), so nesting this inside a
 * FallbackSearchEngine never lets one member's rate limit collapse the
 * whole group's fate -- the entire reason to round-robin quota-limited
 * peers is to keep their quotas independent. A cooling-down slot is
 * skipped in favor of the next available one; if every engine is cooling
 * down, the call throws (letting an outer FallbackSearchEngine fall
 * through to its next entry, e.g. DDG).
 *
 * Still does no fallback on a genuine call failure -- the picked engine's
 * error propagates as-is rather than trying a sibling within the same
 * call. That stays the outer FallbackSearchEngine's job.
 *
 * @example
 * // Spread load across three paid engines, DDG as the zero-cost last resort
 * const engine = new FallbackSearchEngine([
 *   new RoundRobinSearchEngine([tavily, serper, serpapi]),
 *   new DdgSearchEngine(),
 * ]);
 */
export declare class RoundRobinSearchEngine implements ISearchEngine {
    private readonly engines;
    private cursor;
    private readonly cooldownMs;
    private readonly isRateLimitError;
    private readonly now;
    private readonly onEngineFailure;
    private readonly cooldownUntil;
    constructor(engines: ISearchEngine[], opts?: RoundRobinSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/**
 * Build a search chain from environment variables: every keyed engine
 * (brave/tavily/exa/serper/serpapi) that actually has an API key
 * configured is round-robined as an equal-tier peer -- spreading quota
 * consumption across whichever are available instead of always hitting
 * one first -- with DuckDuckGo always appended as the zero-cost last
 * resort. An engine with no key and no usable free tier is auto-skipped,
 * same as today: it's simply never added to the chain, never throws.
 *
 * Falls back to a single ungrouped engine (no RoundRobinSearchEngine
 * wrapper) when only one keyed engine is configured -- rotating among one
 * option is a no-op, and skipping the wrapper keeps single-key behavior
 * (still the common case, e.g. Tavily-only) and its onEngineFailure naming
 * identical to before round-robin existed.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export interface DefaultSearchEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.cooldownMs. */
    cooldownMs?: number;
    /**
     * Reports every engine failure by real name ("brave"/"tavily"/"exa"/
     * "serper"/"serpapi"/"ddg"), including one inside the round-robin group --
     * never the generic "rotation-group" placeholder, which only ever reaches
     * the outer fallback chain's own accounting once every peer in the group
     * is already exhausted.
     */
    onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
}
export declare function defaultSearchEngine(opts?: DefaultSearchEngineOptions): ISearchEngine;
//# sourceMappingURL=web-search.d.ts.map