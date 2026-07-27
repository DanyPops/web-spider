/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */

// WebSearchResult is defined in ports.ts (the abstraction layer).
// web-search.ts is an adapter — it imports from the port, not the other way.
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

/** Header names worth capturing when present -- never a blanket capture of every response header. */
const RATE_LIMIT_HEADER_PATTERN = /rate.?limit|remaining|quota/i;

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
	/** Called once with this call's own dollar cost, when Exa reports one (only non-zero costs are included in its response). */
	onUsage?: (usage: EngineUsage) => void;
}

/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export async function exaSearch(query: string, opts: ExaSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["EXA_API_KEY"];
	if (!apiKey) throw new Error("Exa API key required — set EXA_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.exa.ai/search", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({
				query,
				numResults: opts.numResults ?? 10,
				type: opts.type ?? "auto",
				contents: {
					highlights: { numSentences: 2, highlightsPerUrl: 3 },
				},
			}),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Exa API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		results?: Array<{
			url: string;
			title: string;
			publishedDate?: string;
			highlights?: string[];
		}>;
		costDollars?: { total: number };
	};

	if (data.costDollars?.total !== undefined) opts.onUsage?.({ costUsd: data.costDollars.total });

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.highlights?.join(" … ") ?? "",
		...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
	}));
}

/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export async function braveSearch(query: string, opts: BraveSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["BRAVE_SEARCH_API_KEY"];
	if (!apiKey) throw new Error("Brave Search API key required — set BRAVE_SEARCH_API_KEY or pass opts.apiKey");

	const params = new URLSearchParams({
		q: query,
		count: String(Math.min(opts.numResults ?? 10, 20)),
	});
	if (opts.country) params.set("country", opts.country);
	if (opts.freshness) params.set("freshness", opts.freshness);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let res: Response;
	try {
		res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": apiKey,
			},
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);

	const rateLimitHeaders: Record<string, string> = {};
	for (const [name, value] of res.headers.entries()) {
		if (RATE_LIMIT_HEADER_PATTERN.test(name)) rateLimitHeaders[name] = value;
	}
	if (Object.keys(rateLimitHeaders).length > 0) opts.onUsage?.({ rateLimitHeaders });

	const data = (await res.json()) as {
		web?: {
			results?: Array<{
				url: string;
				title: string;
				description?: string;
				age?: string;
			}>;
		};
	};

	return (data.web?.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.description ?? "",
		...(r.age ? { publishedAt: r.age } : {}),
	}));
}

/**
 * Search the web via the Tavily API.
 * https://docs.tavily.com/docs/rest-api/api-reference
 */
export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["TAVILY_API_KEY"];
	if (!apiKey) throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				api_key: apiKey,
				max_results: opts.numResults ?? 5,
				search_depth: opts.depth ?? "basic",
				include_raw_content: false,
				// Free (no extra cost, per Tavily's own docs) -- just adds a `usage`
				// field to the response reporting this one call's own credit cost.
				include_usage: true,
				...(opts.timeRange ? { time_range: opts.timeRange } : {}),
				...(opts.topic ? { topic: opts.topic } : {}),
			}),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		results?: Array<{
			url: string;
			title: string;
			content?: string;
			published_date?: string;
		}>;
		usage?: { credits: number };
	};

	if (data.usage?.credits !== undefined) opts.onUsage?.({ credits: data.usage.credits });

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.content ?? "",
		...(r.published_date ? { publishedAt: r.published_date } : {}),
	}));
}

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
export async function serperSearch(query: string, opts: SerperSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["SERPER_API_KEY"];
	if (!apiKey) throw new Error("Serper API key required — set SERPER_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let res: Response;
	try {
		res = await fetch("https://google.serper.dev/search", {
			method: "POST",
			signal: controller.signal,
			headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ q: query, num: opts.numResults ?? 10 }),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Serper API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		organic?: Array<{ title: string; link: string; snippet?: string; date?: string }>;
	};

	return (data.organic ?? []).map((r) => ({
		url: r.link,
		title: r.title,
		snippet: r.snippet ?? "",
		...(r.date ? { publishedAt: r.date } : {}),
	}));
}

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
export async function serpApiSearch(query: string, opts: SerpApiSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["SERPAPI_API_KEY"];
	if (!apiKey) throw new Error("SerpApi key required — set SERPAPI_API_KEY or pass opts.apiKey");

	const params = new URLSearchParams({
		engine: "google",
		q: query,
		api_key: apiKey,
		num: String(opts.numResults ?? 10),
	});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`SerpApi error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		error?: string;
		organic_results?: Array<{ title: string; link: string; snippet?: string; date?: string }>;
	};
	if (data.error) throw new Error(`SerpApi error: ${data.error}`);

	return (data.organic_results ?? []).map((r) => ({
		url: r.link,
		title: r.title,
		snippet: r.snippet ?? "",
		...(r.date ? { publishedAt: r.date } : {}),
	}));
}

// ---------------------------------------------------------------------------
// DuckDuckGo Instant Answer API — no key required, zero-cost fallback
// ---------------------------------------------------------------------------

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
export async function ddgSearch(query: string, opts: DdgSearchOptions = {}): Promise<WebSearchResult[]> {
	const params = new URLSearchParams({
		q: query,
		format: "json",
		no_redirect: "1",
		no_html: "1",
		skip_disambig: "1",
	});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let res: Response;
	try {
		res = await fetch(`https://api.duckduckgo.com/?${params}`, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				// DDG silently returns an empty 200 body for browser-like or
				// missing User-Agents. A curl/bot-style UA gets a real 202.
				"User-Agent": "web-spider/0.8",
			},
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`DDG API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		Abstract?: string;
		AbstractURL?: string;
		AbstractSource?: string;
		Heading?: string;
		Results?: Array<{ FirstURL: string; Text: string }>;
		RelatedTopics?: Array<{
			FirstURL?: string;
			Text?: string;
			Topics?: Array<{ FirstURL: string; Text: string }>;
		}>;
	};

	const results: WebSearchResult[] = [];
	const limit = opts.numResults ?? 10;

	// 1. Instant answer abstract (Wikipedia-style knowledge panel)
	if (data.Abstract && data.AbstractURL) {
		results.push({
			url: data.AbstractURL,
			title: data.Heading ?? data.AbstractSource ?? "DuckDuckGo",
			snippet: data.Abstract,
		});
	}

	// 2. Official results (e.g. official site links)
	for (const r of data.Results ?? []) {
		if (results.length >= limit) break;
		if (r.FirstURL) results.push({ url: r.FirstURL, title: r.Text, snippet: r.Text });
	}

	// 3. Related topics — flatten one level of nesting
	for (const topic of data.RelatedTopics ?? []) {
		if (results.length >= limit) break;
		if (topic.FirstURL && topic.Text) {
			results.push({ url: topic.FirstURL, title: topic.Text, snippet: topic.Text });
		}
		for (const sub of topic.Topics ?? []) {
			if (results.length >= limit) break;
			results.push({ url: sub.FirstURL, title: sub.Text, snippet: sub.Text });
		}
	}

	return results;
}

/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Falls through to the DDG Instant Answer API as a zero-cost
 * last resort — no key required.
 *
 * Prefer {@link defaultSearchEngine} + {@link FallbackSearchEngine} when
 * you need composable retry / fallback behaviour.
 */
export async function webSearch(
	query: string,
	opts: {
		engine?: SearchEngine;
		numResults?: number;
		timeRange?: "day" | "week" | "month" | "year";
		topic?: "news" | "general";
	} = {},
): Promise<WebSearchResult[]> {
	const engine = opts.engine
		? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
		: defaultSearchEngine();
	return engine.search({
		query,
		numResults: opts.numResults,
		timeRange: opts.timeRange,
		topic: opts.topic,
	});
}

// ---------------------------------------------------------------------------
// Engine registry — OCP: adding a new engine = one registerSearchEngine() call
// ---------------------------------------------------------------------------

/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines (e.g. DDG).
 */
type EngineFactory = (key: string | undefined) => ISearchEngine;

/** The global engine registry. Seeded with built-in engines below. */
const ENGINE_REGISTRY = new Map<string, EngineFactory>();

/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export function registerSearchEngine(name: string, factory: EngineFactory): void {
	ENGINE_REGISTRY.set(name, factory);
}

/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export function resolveSearchEngine(name: string, key?: string | undefined): ISearchEngine {
	const factory = ENGINE_REGISTRY.get(name);
	if (!factory) throw new Error(`Unknown search engine: "${name}". Register it with registerSearchEngine().`);
	return factory(key);
}

/** @internal Map engine name to its env var key name (for webSearch auto-detect). */
function envKeyForEngine(name: string): string {
	const envKeys: Record<string, string> = {
		brave: "BRAVE_SEARCH_API_KEY",
		tavily: "TAVILY_API_KEY",
		exa: "EXA_API_KEY",
		serper: "SERPER_API_KEY",
		serpapi: "SERPAPI_API_KEY",
	};
	return envKeys[name] ?? "";
}

// Seed the registry with built-in engines.
// Adding a new engine: call registerSearchEngine() — do NOT edit this block.
registerSearchEngine("brave", (key) => {
	if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
	return new BraveSearchEngine(key);
});
registerSearchEngine("tavily", (key) => {
	if (!key) throw new Error("TAVILY_API_KEY not set");
	return new TavilySearchEngine(key);
});
registerSearchEngine("exa", (key) => {
	if (!key) throw new Error("EXA_API_KEY not set");
	return new ExaSearchEngine(key);
});
registerSearchEngine("serper", (key) => {
	if (!key) throw new Error("SERPER_API_KEY not set");
	return new SerperSearchEngine(key);
});
registerSearchEngine("serpapi", (key) => {
	if (!key) throw new Error("SERPAPI_API_KEY not set");
	return new SerpApiSearchEngine(key);
});
registerSearchEngine("ddg", () => new DdgSearchEngine());

// ---------------------------------------------------------------------------
// ISearchEngine adapters — concrete implementations of the port
// ---------------------------------------------------------------------------

/** Maps the canonical timeRange string to Brave's freshness parameter. */
const BRAVE_FRESHNESS: Record<string, "pd" | "pw" | "pm" | "py"> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string, private readonly country?: string, private readonly onUsage?: (usage: EngineUsage) => void) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		const freshness = req.timeRange ? BRAVE_FRESHNESS[req.timeRange] : undefined;
		return braveSearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			country: this.country,
			freshness,
			onUsage: this.onUsage,
		});
	}
}

/** Tavily adapter implementing ISearchEngine. */
export class TavilySearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string, private readonly onUsage?: (usage: EngineUsage) => void) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return tavilySearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			timeRange: req.timeRange,
			topic: req.topic,
			onUsage: this.onUsage,
		});
	}
}

/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string, private readonly onUsage?: (usage: EngineUsage) => void) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return exaSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, onUsage: this.onUsage });
	}
}

/** Serper.dev adapter implementing ISearchEngine. */
export class SerperSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serperSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
	}
}

/** SerpApi adapter implementing ISearchEngine. */
export class SerpApiSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serpApiSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
	}
}

/** DuckDuckGo Instant Answer adapter — no API key required. */
export class DdgSearchEngine implements ISearchEngine {
	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return ddgSearch(req.query, { numResults: req.numResults });
	}
}

// ---------------------------------------------------------------------------
// FallbackSearchEngine — strategy composite
// ---------------------------------------------------------------------------

/** True for a short-lived throttling response worth a brief cooldown: standard 429 and "too many requests"/"rate limit" phrasing. Distinct from {@link isLikelyQuotaExceededError} -- a request-rate throttle clears in seconds to minutes, an exhausted account quota does not. */
export function isLikelyRateLimitError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (/\b429\b/.test(error.message)) return true;
	return /rate.?limit|too many requests/i.test(error.message);
}

/** True for an account-level quota/plan exhaustion worth a much longer disable than a rate limit: Tavily's non-standard 432, 402 Payment Required, and phrasing like "quota exceeded", "usage limit", "out of searches/credits", "plan limit". Retrying before the billing/quota window resets just wastes a call and re-triggers the same failure. */
export function isLikelyQuotaExceededError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (/\b(432|402)\b/.test(error.message)) return true;
	return /quota|usage limit|out of (searches|credits)|plan limit|insufficient credits|run out of/i.test(error.message);
}

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
 * // Tavily with DDG as zero-cost fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new DdgSearchEngine(),
 * ]);
 */
export class FallbackSearchEngine implements ISearchEngine {
	private readonly fallbackOnEmpty: boolean;
	private readonly fallbackOnError: boolean;
	private readonly cooldownMs: number;
	private readonly quotaCooldownMs: number;
	private readonly isRateLimitError: RateLimitPredicate;
	private readonly isQuotaError: RateLimitPredicate;
	private readonly now: () => number;
	private readonly onEngineFailure: FallbackSearchEngineOptions["onEngineFailure"];
	/** engines[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
	private readonly cooldownUntil: number[];

	constructor(
		private readonly engines: ISearchEngine[],
		opts: FallbackSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("FallbackSearchEngine requires at least one engine");
		this.fallbackOnEmpty = opts.fallbackOnEmpty ?? true;
		this.fallbackOnError = opts.fallbackOnError ?? true;
		this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
		this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
		this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
		this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
		this.now = opts.now ?? Date.now;
		this.onEngineFailure = opts.onEngineFailure;
		this.cooldownUntil = engines.map(() => 0);
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		let lastError: unknown;
		// Gates the final throw below: a later engine completing with zero hits
		// is a real empty result, never masked by an earlier engine's error.
		let anySucceeded = false;

		for (let i = 0; i < this.engines.length; i++) {
			if ((this.cooldownUntil[i] as number) > this.now()) {
				const cooldownError = new Error(`engine ${i} skipped: in cooldown after a recent rate-limit/quota error`);
				lastError = cooldownError;
				this.onEngineFailure?.(i, cooldownError, "cooldown");
				continue;
			}
			try {
				const results = await (this.engines[i] as ISearchEngine).search(req);
				anySucceeded = true;
				if (results.length > 0 || !this.fallbackOnEmpty) return results;
				// Empty + fallbackOnEmpty → try next engine
			} catch (err) {
				if (!this.fallbackOnError) throw err;
				lastError = err;
				if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
					this.cooldownUntil[i] = this.now() + this.quotaCooldownMs;
					this.onEngineFailure?.(i, err, "quota");
				} else {
					if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
						this.cooldownUntil[i] = this.now() + this.cooldownMs;
					}
					this.onEngineFailure?.(i, err, "error");
				}
				// Error + fallbackOnError → try next engine
			}
		}

		if (!anySucceeded && lastError) throw lastError;
		return [];
	}
}

// ---------------------------------------------------------------------------
// RoundRobinSearchEngine — quota-spreading composite
// ---------------------------------------------------------------------------

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
export class RoundRobinSearchEngine implements ISearchEngine {
	private cursor = 0;
	private readonly cooldownMs: number;
	private readonly quotaCooldownMs: number;
	private readonly isRateLimitError: RateLimitPredicate;
	private readonly isQuotaError: RateLimitPredicate;
	private readonly now: () => number;
	private readonly onEngineFailure: RoundRobinSearchEngineOptions["onEngineFailure"];
	private readonly cooldownUntil: number[];

	constructor(
		private readonly engines: ISearchEngine[],
		opts: RoundRobinSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("RoundRobinSearchEngine requires at least one engine");
		this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
		this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
		this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
		this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
		this.now = opts.now ?? Date.now;
		this.onEngineFailure = opts.onEngineFailure;
		this.cooldownUntil = engines.map(() => 0);
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		const start = this.cursor;
		this.cursor = (start + 1) % this.engines.length;

		let index = -1;
		for (let attempt = 0; attempt < this.engines.length; attempt++) {
			const candidate = (start + attempt) % this.engines.length;
			if ((this.cooldownUntil[candidate] as number) > this.now()) {
				const cooldownError = new Error(`engine ${candidate} skipped: in cooldown after a recent rate-limit/quota error`);
				this.onEngineFailure?.(candidate, cooldownError, "cooldown");
				continue;
			}
			index = candidate;
			break;
		}

		if (index === -1) throw new Error("RoundRobinSearchEngine: every engine is currently in cooldown");

		try {
			return await (this.engines[index] as ISearchEngine).search(req);
		} catch (err) {
			if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
				this.cooldownUntil[index] = this.now() + this.quotaCooldownMs;
				this.onEngineFailure?.(index, err, "quota");
			} else {
				if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
					this.cooldownUntil[index] = this.now() + this.cooldownMs;
				}
				this.onEngineFailure?.(index, err, "error");
			}
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// Wiring — compose engines from environment variables
// ---------------------------------------------------------------------------

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
	/** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.quotaCooldownMs. */
	quotaCooldownMs?: number;
	/**
	 * Reports every engine failure by real name ("brave"/"tavily"/"exa"/
	 * "serper"/"serpapi"/"ddg"), including one inside the round-robin group --
	 * never the generic "rotation-group" placeholder, which only ever reaches
	 * the outer fallback chain's own accounting once every peer in the group
	 * is already exhausted.
	 */
	onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
	/** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
	onUsage?: (engineName: string, usage: EngineUsage) => void;
}

export function defaultSearchEngine(opts: DefaultSearchEngineOptions = {}): ISearchEngine {
	const env = opts.env ?? process.env;
	const rotationEngines: ISearchEngine[] = [];
	const rotationNames: string[] = [];

	const brave = env["BRAVE_SEARCH_API_KEY"];
	if (brave) { rotationEngines.push(new BraveSearchEngine(brave, undefined, opts.onUsage ? (usage) => opts.onUsage?.("brave", usage) : undefined)); rotationNames.push("brave"); }

	const tavily = env["TAVILY_API_KEY"];
	if (tavily) { rotationEngines.push(new TavilySearchEngine(tavily, opts.onUsage ? (usage) => opts.onUsage?.("tavily", usage) : undefined)); rotationNames.push("tavily"); }

	const exa = env["EXA_API_KEY"];
	if (exa) { rotationEngines.push(new ExaSearchEngine(exa, opts.onUsage ? (usage) => opts.onUsage?.("exa", usage) : undefined)); rotationNames.push("exa"); }

	const serper = env["SERPER_API_KEY"];
	if (serper) { rotationEngines.push(new SerperSearchEngine(serper)); rotationNames.push("serper"); }

	const serpapi = env["SERPAPI_API_KEY"];
	if (serpapi) { rotationEngines.push(new SerpApiSearchEngine(serpapi)); rotationNames.push("serpapi"); }

	const engines: ISearchEngine[] = [];
	const outerNames: string[] = [];

	if (rotationEngines.length === 1) {
		engines.push(rotationEngines[0] as ISearchEngine);
		outerNames.push(rotationNames[0] as string);
	} else if (rotationEngines.length > 1) {
		engines.push(new RoundRobinSearchEngine(rotationEngines, {
			cooldownMs: opts.cooldownMs,
			quotaCooldownMs: opts.quotaCooldownMs,
			onEngineFailure: opts.onEngineFailure ? (index, error, reason) => opts.onEngineFailure?.(rotationNames[index] ?? `engine-${index}`, error, reason) : undefined,
		}));
		outerNames.push("rotation-group");
	}

	// DDG always last — no key needed, never throws the "no key" error
	engines.push(new DdgSearchEngine());
	outerNames.push("ddg");

	// The round-robin group already tracks cooldown (both tiers) per real
	// engine inside itself. If the outer chain also cooled down the *group's
	// own slot* whenever one member's failure bubbles up through it, a single
	// exhausted peer would collapse the whole group's fate one layer up --
	// exactly the bug round-robin exists to avoid. Disable both outer-layer
	// cooldown tiers whenever there's a group to protect; the single-keyed-
	// engine case (no group) keeps its own outer cooldowns exactly as before.
	const outerCooldownMs = rotationEngines.length > 1 ? 0 : opts.cooldownMs;
	const outerQuotaCooldownMs = rotationEngines.length > 1 ? 0 : opts.quotaCooldownMs;

	return new FallbackSearchEngine(engines, {
		cooldownMs: outerCooldownMs,
		quotaCooldownMs: outerQuotaCooldownMs,
		onEngineFailure: opts.onEngineFailure ? (index, error, reason) => opts.onEngineFailure?.(outerNames[index] ?? `engine-${index}`, error, reason) : undefined,
	});
}
