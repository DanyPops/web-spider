/**
 * Port interfaces — the contracts the core depends on.
 *
 * No concrete imports. Adapters implement these; the core orchestrates them.
 * All ports are optional in SpiderOptions — concrete defaults are wired in
 * spider.ts and crawl.ts so callers need not supply them unless they want
 * to substitute (e.g. inject a mock HTTP client for testing).
 */

// ---------------------------------------------------------------------------
// IHttpClient
// ---------------------------------------------------------------------------

export interface HttpRequest {
	url: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Minimal HTTP client port.
 * Default adapter wraps global fetch().
 * Swap for tests: return fixed HTML without touching the network.
 */
export interface IHttpClient {
	fetch(req: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// ICache<K, V>
// ---------------------------------------------------------------------------

/**
 * Generic cache port.
 * Default adapter: SpiderCache (LRU, TTL).
 * Swap for tests or production: in-memory Map, Redis, SQLite, etc.
 */
export interface ICache<K, V> {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	has(key: K): boolean;
	delete(key: K): void;
	/** All currently valid (non-expired) values. */
	values(): V[];
}

// ---------------------------------------------------------------------------
// IThrottle
// ---------------------------------------------------------------------------

/**
 * Per-domain request throttle port.
 * Default adapter: DomainThrottle (token bucket + exponential backoff).
 * Swap for tests: no-op implementation that always resolves immediately.
 */
export interface IThrottle {
	wait(url: string): Promise<void>;
	success(url: string): void;
	rateLimit(url: string, retryAfterHeader: string | null): number;
	setDomainDelay(host: string, ms: number): void;
	readonly maxRetries: number;
}

// ---------------------------------------------------------------------------
// IRobotsChecker
// ---------------------------------------------------------------------------

export interface RobotsResult {
	allowed: boolean;
	crawlDelayMs?: number;
}

/**
 * robots.txt compliance port.
 * Default adapter: RobotsCache (fetches + parses per origin, 1h TTL).
 * Swap for tests: permissive stub that always returns { allowed: true }.
 */
export interface IRobotsChecker {
	check(url: string): Promise<RobotsResult>;
}

// ---------------------------------------------------------------------------
// ISearchEngine
// ---------------------------------------------------------------------------

export interface SearchQuery {
	query: string;
	numResults?: number;
	/**
	 * Restrict results to content published within this window.
	 * Supported by Tavily ("day"|"week"|"month"|"year") and Brave ("pd"|"pw"|"pm"|"py").
	 * Adapters map this to their engine-specific parameter name.
	 */
	timeRange?: "day" | "week" | "month" | "year";
	/**
	 * Search topic mode. "news" prioritises freshly indexed news articles.
	 * Supported by Tavily. Ignored by engines that don't support it.
	 */
	topic?: "news" | "general";
	/**
	 * Restrict results to one domain (e.g. "reddit.com"). Adapters with a
	 * native domain filter (Tavily's includeDomains, Exa's includeDomains,
	 * You.com's include_domains) map it directly; keyword/SERP-style engines
	 * with no structured param (Brave, Serper, SerpApi) append a `site:`
	 * operator to the query text instead. {@link SiteRoutedSearchEngine}
	 * uses this field to track, per site, which configured engines actually
	 * return matching results -- some domains (e.g. reddit.com, which
	 * blocked all crawlers but Google's in its 2024 robots.txt change)
	 * return zero real coverage from most engines regardless of the filter.
	 */
	siteFilter?: string;
	/**
	 * Declares intent -- "give me full page content" -- without naming which
	 * engine or option produces it. An {@link ISearchEngine} adapter that can
	 * satisfy this (Tavily via its own include_raw_content, Exa via its own
	 * contents.text) maps it to that vendor-specific parameter internally;
	 * one that can't (Brave, Serper, SerpApi, You.com) ignores it, same as an
	 * unsupported timeRange/topic. Populates {@link WebSearchResult.content}
	 * when honoured. Prefer this over calling a vendor-specific function
	 * (tavilySearch's includeRawContent, exaSearch's includeText) directly --
	 * those still exist for callers who already know which vendor they want,
	 * but a caller going through {@link ISearchEngine}/{@link webSearch} should
	 * never need to know which vendor's option name means "give me content".
	 */
	wantFullContent?: boolean;
}

/**
 * A single result from a web search engine.
 * Defined here so port interfaces have no dependency on adapter modules.
 */
export interface WebSearchResult {
	url: string;
	title: string;
	/** Short description or snippet from the search engine. */
	snippet: string;
	/** ISO-8601 or human-readable date, if the engine returned one. */
	publishedAt?: string;
	/** Additional pre-extracted passages beyond the single snippet, when the engine returns more than one (Exa, You.com). Never fabricated -- absent when the engine only ever returns one. */
	highlights?: string[];
	/** Full page content (markdown/HTML/raw text), only populated when the caller opted into fetching it (e.g. Tavily's includeRawContent) -- absent by default since it costs more and inflates payload size. */
	content?: string;
}

/**
 * Result of an answer-first engine call: a synthesized answer plus the
 * sources it was built from, as distinct from {@link ISearchEngine}'s
 * results-first list. Kept as a separate port rather than folded into
 * WebSearchResult[] -- an answer-first response isn't a ranked list of
 * pages, and squeezing it into one would either fabricate a fake single
 * "result" or silently make one engine's search() return richer data than
 * the interface promises every other caller.
 */
export interface AnswerResult {
	answer: string;
	sources: WebSearchResult[];
}

/**
 * Answer-first web search port -- distinct from {@link ISearchEngine}.
 * Adapters implement this alongside ISearchEngine when the underlying API
 * supports both modes (e.g. TavilySearchEngine, via Tavily's own
 * include_answer). A caller that only wants a synthesized, cited answer
 * uses this instead of search() + doing its own summarization.
 */
export interface IAnswerSearchEngine {
	searchForAnswer(req: SearchQuery): Promise<AnswerResult>;
}

/**
 * Tracks, per site (domain), which configured search engines have actually
 * returned matching results versus come back empty -- so a caller doesn't
 * re-pay the same "try every engine" cost on every call against a site
 * some engines have no real coverage of (see {@link SiteRoutedSearchEngine}).
 * A verdict is advisory, not a hard exclusion: implementations should let a
 * previously-blocked engine be retried after some interval, since access
 * can change (a new licensing deal, a policy reversal) independently of
 * this process's own lifetime.
 */
export interface SiteAvailabilityTracker {
	/** Record whether `engineName` returned at least one matching result for `site` on this attempt. */
	recordAttempt(site: string, engineName: string, matched: boolean): void;
	/**
	 * Reorders `engineNames` for `site`: engines with a past match first,
	 * untested engines next, currently-verified-blocked engines last.
	 * Never drops an engine -- only reorders, so a query can still reach a
	 * blocked-but-now-fixed backend if every preferred one also fails.
	 */
	order(site: string, engineNames: readonly string[]): string[];
}

/**
 * Web search engine port.
 * Adapters: BraveSearchEngine, TavilySearchEngine (in web-search.ts).
 * Swap for tests: stub returning fixed results.
 */
export interface ISearchEngine {
	search(req: SearchQuery): Promise<WebSearchResult[]>;
}

/**
 * Per-call usage/cost data an engine reported for the search that just ran,
 * when it reported anything at all -- every field is independently optional
 * because no provider reports all of these, and some (Brave, as of this
 * writing) may report none. Never a running account balance: every provider
 * checked (Tavily, Exa) only ever reports what one call cost, not what's
 * left. A consumer that wants a running total accumulates these itself.
 */
export interface EngineUsage {
	/** Credits consumed by this one call (Tavily, opt-in via includeUsage). */
	credits?: number;
	/** Dollar cost of this one call (Exa, reported automatically when non-zero). */
	costUsd?: number;
	/** Raw response headers whose name looked rate-limit/quota-shaped, lower-cased keys, verbatim string values. Never blanket-captured -- only headers matching that shape are ever collected. */
	rateLimitHeaders?: Record<string, string>;
}
