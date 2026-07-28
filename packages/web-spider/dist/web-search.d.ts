/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
export type { AnswerResult, IAnswerSearchEngine, SiteAvailabilityTracker, WebSearchResult } from "./ports.js";
import type { AnswerResult, EngineUsage, IAnswerSearchEngine, ISearchEngine, SearchQuery, SiteAvailabilityTracker, WebSearchResult } from "./ports.js";
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
    /** Restrict results to one domain. Maps to Tavily's own `include_domains` array param (we only ever send one entry). */
    siteFilter?: string;
    /** Include each result's full cleaned/parsed page content in {@link WebSearchResult.content}. Off by default -- costs more and inflates payload size (Tavily's own `include_raw_content`). */
    includeRawContent?: boolean;
    /** Called once with this call's own credit cost, when Tavily reports one. */
    onUsage?: (usage: EngineUsage) => void;
}
export type SearchEngine = "brave" | "tavily" | "exa" | "serper" | "serpapi" | "you";
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
/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Throws when no provider key is configured — see
 * {@link defaultSearchEngine} for the "no engine configured" error shape.
 *
 * Prefer {@link defaultSearchEngine} + {@link FallbackSearchEngine} when
 * you need composable retry / fallback behaviour.
 */
export interface WebSearchOptions {
    engine?: SearchEngine;
    numResults?: number;
    timeRange?: "day" | "week" | "month" | "year";
    topic?: "news" | "general";
    siteFilter?: string;
    /** See {@link SearchQuery.wantFullContent}. Ignored when wantAnswer is also set -- an answer-first call has no results list to attach content to. */
    wantFullContent?: boolean;
}
/**
 * wantAnswer: true -- resolves an answer-capable engine by capability (see
 * {@link defaultAnswerEngine}) and returns a synthesized {@link AnswerResult}
 * instead of a results list. The return type follows the declared want,
 * not which engine happens to serve it.
 */
export declare function webSearch(query: string, opts: WebSearchOptions & {
    wantAnswer: true;
}): Promise<AnswerResult>;
export declare function webSearch(query: string, opts?: WebSearchOptions & {
    wantAnswer?: false;
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
/** Every engine name currently registered -- a consumer that needs to iterate all known backends (e.g. a local credential store) never hardcodes a second copy of this list. */
export declare function listRegisteredSearchEngines(): string[];
/** Map an engine name to its env var key name (for webSearch auto-detect, and for anything else that needs the same canonical mapping). Returns "" for an unknown name. */
export declare function envKeyForEngine(name: string): string;
/** Brave Search adapter implementing ISearchEngine. */
export declare class BraveSearchEngine implements ISearchEngine {
    private readonly apiKey;
    private readonly country?;
    private readonly onUsage?;
    private readonly extraSnippets;
    constructor(apiKey: string, country?: string | undefined, onUsage?: ((usage: EngineUsage) => void) | undefined, extraSnippets?: boolean);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/** Tavily adapter implementing ISearchEngine and IAnswerSearchEngine (reference implementation of the answer-first port, via Tavily's own include_answer). */
export declare class TavilySearchEngine implements ISearchEngine, IAnswerSearchEngine {
    private readonly apiKey;
    private readonly onUsage?;
    constructor(apiKey: string, onUsage?: ((usage: EngineUsage) => void) | undefined);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
    searchForAnswer(req: SearchQuery): Promise<AnswerResult>;
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
/** You.com adapter implementing ISearchEngine. */
export declare class YouComSearchEngine implements ISearchEngine {
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
export interface InMemorySiteAvailabilityTrackerOptions {
    /** Max distinct sites tracked; the oldest (by last-touched) is evicted first once exceeded. Default 500. */
    maxSites?: number;
    /** How long a "blocked" verdict (zero matching results) is trusted before that engine is worth retrying for the site. Default 24h -- long enough to stop re-paying the cost every call, short enough that a real policy change (a new licensing deal, e.g.) is eventually rediscovered. */
    blockedTtlMs?: number;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
}
/**
 * Default {@link SiteAvailabilityTracker}: an in-memory, bounded map from
 * site to per-engine verdicts. Process-lifetime only -- a daemon wanting
 * cross-restart persistence injects its own implementation of the same
 * port (e.g. backed by its existing SQLite store) instead.
 */
export declare class InMemorySiteAvailabilityTracker implements SiteAvailabilityTracker {
    private readonly records;
    private readonly maxSites;
    private readonly blockedTtlMs;
    private readonly now;
    constructor(opts?: InMemorySiteAvailabilityTrackerOptions);
    recordAttempt(site: string, engineName: string, matched: boolean): void;
    order(site: string, engineNames: readonly string[]): string[];
}
export interface NamedSearchEngine {
    name: string;
    engine: ISearchEngine;
    /**
     * True when this engine can honour {@link SearchQuery.wantFullContent}
     * (Tavily, Exa). Declared once at wiring time rather than learned --
     * unlike per-site coverage, content support is a fixed vendor capability,
     * not something that needs discovering empirically per call.
     */
    supportsFullContent?: boolean;
}
export interface SiteRoutedSearchEngineOptions {
    /** Defaults to a fresh InMemorySiteAvailabilityTracker. */
    tracker?: SiteAvailabilityTracker;
}
/**
 * Wraps a set of named engines plus a plain fallback/rotation engine. For a
 * site-filtered query (SearchQuery.siteFilter, or a `site:domain` operator
 * detected in the raw query text) it tries the named engines in an order
 * informed by which have actually returned matching results for that site
 * before -- known-working first, untested next, recently-verified-blocked
 * last -- filtering each engine's raw results down to ones that genuinely
 * match the requested domain (an engine that ignores the filter entirely,
 * or has no real crawl coverage of the site, reports zero matches rather
 * than off-topic results). Every attempt updates the tracker, so a real
 * block (e.g. Reddit's 2024 robots.txt change locking out every search
 * engine but Google-backed ones) is learned once per site instead of
 * re-paid on every subsequent call -- while the verdict still expires
 * (see {@link InMemorySiteAvailabilityTrackerOptions.blockedTtlMs}), so a
 * later-fixed engine gets retried instead of being written off forever.
 *
 * Falls straight through to the plain engine, untouched, for a query with
 * no site filter -- this composite only ever activates for domain-
 * restricted queries.
 */
export declare class SiteRoutedSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly plain;
    private readonly tracker;
    constructor(engines: NamedSearchEngine[], plain: ISearchEngine, opts?: SiteRoutedSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/**
 * Wraps a set of named engines plus a plain fallback/rotation engine.
 * Realizes {@link SearchQuery.wantFullContent} as routing, not just a
 * per-adapter hint: a caller declares the *want*, this decides *who*
 * satisfies it, by capability rather than by name -- the same principle
 * {@link SiteRoutedSearchEngine} already applies to domain coverage.
 *
 * When wantFullContent is set, tries engines with
 * {@link NamedSearchEngine.supportsFullContent} first, in order, before
 * falling through to the plain chain -- so a content-capable engine is
 * preferred over whichever the round-robin's cursor happens to land on.
 * Falls through to plain (not a throw) when no content-capable engine is
 * configured at all, or every one of them fails: a declared want that
 * can't be satisfied should degrade to an ordinary result, not fail the
 * whole query, mirroring how an unsupported timeRange/topic is silently
 * ignored rather than rejected.
 *
 * Delegates straight to plain, untouched, when wantFullContent isn't set --
 * this composite only ever activates for that one declared intent.
 */
export declare class CapabilityRoutedSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly plain;
    constructor(engines: NamedSearchEngine[], plain: ISearchEngine);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
/**
 * Build a search chain from environment variables: every keyed engine
 * (brave/tavily/exa/serper/serpapi/you) that actually has an API key
 * configured is round-robined as an equal-tier peer -- spreading quota
 * consumption across whichever are available instead of always hitting
 * one first. An engine with no key configured is auto-skipped, never
 * throws by itself; calling this with zero keys configured throws a
 * single descriptive error instead of silently returning a no-op engine.
 *
 * The whole chain is wrapped in {@link SiteRoutedSearchEngine}: a query
 * with no site filter passes straight through to the round-robin/fallback
 * chain described above, unchanged; a site-filtered query (or one
 * containing a literal `site:domain` operator) is instead routed by which
 * configured engines have actually returned matching results for that
 * site before, so a domain a given engine has no real coverage of (e.g.
 * Reddit, which blocked every crawler but Google-backed ones in 2024) is
 * learned once and skipped on later calls instead of re-paid every time.
 *
 * Returns the RoundRobinSearchEngine directly (before the SiteRoutedSearchEngine
 * wrap) when 2+ keys are configured -- no outer FallbackSearchEngine wrapper
 * for the unfiltered path. There's no keyless engine left to fall through to,
 * so a wrapper around a single entry (the round-robin group itself) would add
 * nothing but a duplicate, generically-named onEngineFailure report for a
 * failure the round-robin already reports by real engine name; its own
 * cooldown would also have to be force-disabled to avoid one member's
 * failure cooling down the whole group a second time.
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
    /** Reports every engine failure by its real name ("brave"/"tavily"/"exa"/"serper"/"serpapi"/"you") -- never a generic placeholder, whether the failure came from the sole configured engine or one member of the round-robin group. */
    onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
    /** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
    /** Tracks per-site engine coverage for site-filtered queries. Defaults to a fresh InMemorySiteAvailabilityTracker (process-lifetime only); inject a persistent implementation for cross-restart memory. See {@link SiteRoutedSearchEngine}. */
    siteAvailabilityTracker?: SiteAvailabilityTracker;
}
export declare function defaultSearchEngine(opts?: DefaultSearchEngineOptions): ISearchEngine;
export interface DefaultAnswerEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Reports every successful call's own usage/cost data by real engine name. See {@link DefaultSearchEngineOptions.onUsage}. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
}
/**
 * Resolves an {@link IAnswerSearchEngine} from configured provider keys, by
 * capability rather than by name -- a caller never names "Tavily" to get an
 * answer; it declares the want (via {@link webSearch}'s wantAnswer, or by
 * calling this directly) and whichever configured engine actually
 * implements searchForAnswer is used. Extending an existing ISearchEngine
 * adapter to also implement IAnswerSearchEngine (e.g. a future Serper/
 * SerpApi answerBox mapping) makes it eligible here with zero other
 * changes -- the whole point of routing by capability instead of name.
 *
 * Throws a distinct, more specific error than {@link defaultSearchEngine}'s
 * own when provider keys exist but none of the configured engines can
 * produce an answer -- "you have Brave configured" is a materially
 * different problem to fix than "you have nothing configured at all".
 */
export declare function defaultAnswerEngine(opts?: DefaultAnswerEngineOptions): IAnswerSearchEngine;
//# sourceMappingURL=web-search.d.ts.map