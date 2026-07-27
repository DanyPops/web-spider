/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
export type { WebSearchResult } from "./ports.js";
import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "./ports.js";
export type { EngineUsage } from "./ports.js";
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
    /**
     * Called once with any rate-limit/quota-shaped response headers Brave sent,
     * when it sent any. Unlike Tavily/Exa, Brave's actual header behavior was
     * not confirmed against real documentation as of this writing (their docs
     * site is JS-rendered, and no official or third-party SDK parses any such
     * header) -- this exists to observe real behavior against a real key
     * rather than assume a shape, and may report nothing at all.
     */
    onUsage?: (usage: EngineUsage) => void;
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
    /** Called once with this call's own credit cost, when Tavily reports one. */
    onUsage?: (usage: EngineUsage) => void;
}
export type SearchEngine = "brave" | "tavily" | "exa" | "serper" | "serpapi";
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
/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Throws when no provider key is configured — see
 * {@link defaultSearchEngine} for the "no engine configured" error shape.
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
 * key is undefined for keyless engines.
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
    private readonly onUsage?;
    constructor(apiKey: string, country?: string | undefined, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** Tavily adapter implementing ISearchEngine. */
export declare class TavilySearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** Exa adapter implementing ISearchEngine. */
export declare class ExaSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
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
/** True for a short-lived throttling response worth a brief cooldown: standard 429 and "too many requests"/"rate limit" phrasing. Distinct from {@link isLikelyQuotaExceededError} -- a request-rate throttle clears in seconds to minutes, an exhausted account quota does not. */
export declare function isLikelyRateLimitError(error: unknown): boolean;
/** True for an account-level quota/plan exhaustion worth a much longer disable than a rate limit: Tavily's non-standard 432, 402 Payment Required, and phrasing like "quota exceeded", "usage limit", "out of searches/credits", "plan limit". Retrying before the billing/quota window resets just wastes a call and re-triggers the same failure. */
export declare function isLikelyQuotaExceededError(error: unknown): boolean;
export type RateLimitPredicate = (error: unknown) => boolean;
/** "error": the engine's search() call threw a non-quota error. "quota": it threw a quota-exhaustion error (see {@link isLikelyQuotaExceededError}), the trigger for the longer quota cooldown. "cooldown": skipped without even calling it, because an earlier failure's cooldown hasn't cleared yet -- covers both the rate-limit and quota cases. */
export type EngineFailureReason = "error" | "quota" | "cooldown";
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
    /** How long (ms) to skip an engine after a rate-limit-shaped failure. Default 10 minutes. 0 disables this cooldown tier. */
    cooldownMs?: number;
    /** How long (ms) to skip an engine after a quota-exhaustion-shaped failure (see {@link isLikelyQuotaExceededError}) -- much longer than a rate-limit cooldown, since retrying before the quota window resets just re-fails and wastes a call. Default 6 hours. 0 disables this cooldown tier (falls through to the rate-limit tier's classification instead). */
    quotaCooldownMs?: number;
    /** Defaults to isLikelyRateLimitError. */
    isRateLimitError?: RateLimitPredicate;
    /** Defaults to isLikelyQuotaExceededError. Checked before isRateLimitError, so a quota-shaped error gets the longer cooldown even if it would also match the rate-limit heuristic. */
    isQuotaError?: RateLimitPredicate;
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
 * // Tavily with Exa as a second-choice fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new ExaSearchEngine(process.env.EXA_API_KEY),
 * ]);
 */
export declare class FallbackSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly fallbackOnEmpty;
    private readonly fallbackOnError;
    private readonly cooldownMs;
    private readonly quotaCooldownMs;
    private readonly isRateLimitError;
    private readonly isQuotaError;
    private readonly now;
    private readonly onEngineFailure;
    /** engines[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
    private readonly cooldownUntil;
    constructor(engines: ISearchEngine[], opts?: FallbackSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
export interface RoundRobinSearchEngineOptions {
    /** How long (ms) to skip an engine's rotation slot after a rate-limit-shaped failure. Default 10 minutes. 0 disables this cooldown tier. */
    cooldownMs?: number;
    /** How long (ms) to skip an engine's rotation slot after a quota-exhaustion-shaped failure (see {@link isLikelyQuotaExceededError}). Default 6 hours. 0 disables this cooldown tier. */
    quotaCooldownMs?: number;
    /** Defaults to isLikelyRateLimitError. */
    isRateLimitError?: RateLimitPredicate;
    /** Defaults to isLikelyQuotaExceededError. Checked before isRateLimitError. */
    isQuotaError?: RateLimitPredicate;
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
 * down, the call throws.
 *
 * Does no fallback on a genuine call failure by itself -- the picked
 * engine's error propagates as-is rather than trying a sibling within the
 * same call. A caller that wants same-call fallback can still nest this
 * inside a FallbackSearchEngine with further entries (defaultSearchEngine's
 * own wiring doesn't, since it has no further keyless entry to offer).
 *
 * @example
 * // Spread load across three paid engines, Exa as a lower-priority fallback
 * const engine = new FallbackSearchEngine([
 *   new RoundRobinSearchEngine([tavily, serper, serpapi]),
 *   new ExaSearchEngine(exaKey),
 * ]);
 */
export declare class RoundRobinSearchEngine implements ISearchEngine {
    private readonly engines;
    private cursor;
    private readonly cooldownMs;
    private readonly quotaCooldownMs;
    private readonly isRateLimitError;
    private readonly isQuotaError;
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
 * one first. An engine with no key configured is auto-skipped, never
 * throws by itself; calling this with zero keys configured throws a
 * single descriptive error instead of silently returning a no-op engine.
 *
 * Returns the RoundRobinSearchEngine directly when 2+ keys are configured --
 * no outer FallbackSearchEngine wrapper. There's no keyless engine left to
 * fall through to, so a wrapper around a single entry (the round-robin group
 * itself) would add nothing but a duplicate, generically-named
 * onEngineFailure report for a failure the round-robin already reports by
 * real engine name; its own cooldown would also have to be force-disabled to
 * avoid one member's failure cooling down the whole group a second time.
 *
 * With exactly one keyed engine, wraps it in a single-entry
 * FallbackSearchEngine purely for the cooldown/quota-cooldown circuit
 * breaker -- without it, a provider already known to be quota-exhausted
 * would be hit again on every call instead of short-circuiting to a clear
 * "in cooldown" error.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export interface DefaultSearchEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.cooldownMs. */
    cooldownMs?: number;
    /** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.quotaCooldownMs. */
    quotaCooldownMs?: number;
    /** Reports every engine failure by its real name ("brave"/"tavily"/"exa"/"serper"/"serpapi") -- never a generic placeholder, whether the failure came from the sole configured engine or one member of the round-robin group. */
    onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
    /** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
}
export declare function defaultSearchEngine(opts?: DefaultSearchEngineOptions): ISearchEngine;
//# sourceMappingURL=web-search.d.ts.map