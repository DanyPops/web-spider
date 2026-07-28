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
export type { AnswerResult, IAnswerSearchEngine, SiteAvailabilityTracker, WebSearchResult } from "./ports.js";
import type { AnswerResult, EngineUsage, IAnswerSearchEngine, ISearchEngine, SearchQuery, SiteAvailabilityTracker, WebSearchResult } from "./ports.js";
export type { EngineUsage } from "./ports.js";

/**
 * Appends a `site:` operator to a raw keyword query for engines with no
 * structured domain-filter parameter (Brave, Serper, SerpApi) -- all three
 * are Google-style keyword search under the hood (Serper/SerpApi literally
 * scrape Google's own SERP), where `site:` is standard, widely-honoured
 * syntax. No-op when siteFilter is unset.
 */
function withSiteFilter(query: string, siteFilter: string | undefined): string {
	return siteFilter ? `${query} site:${siteFilter}` : query;
}

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
					...(opts.includeText ? { text: true } : {}),
				},
				...(opts.siteFilter ? { includeDomains: [opts.siteFilter] } : {}),
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
			text?: string;
		}>;
		costDollars?: { total: number };
	};

	if (data.costDollars?.total !== undefined) opts.onUsage?.({ costUsd: data.costDollars.total });

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.highlights?.join(" … ") ?? "",
		...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
		...(r.highlights && r.highlights.length > 0 ? { highlights: r.highlights } : {}),
		...(r.text ? { content: r.text } : {}),
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
		q: withSiteFilter(query, opts.siteFilter),
		count: String(Math.min(opts.numResults ?? 10, 20)),
	});
	if (opts.country) params.set("country", opts.country);
	if (opts.freshness) params.set("freshness", opts.freshness);
	if (opts.extraSnippets) params.set("extra_snippets", "true");

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
				extra_snippets?: string[];
			}>;
		};
	};

	return (data.web?.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.description ?? "",
		...(r.age ? { publishedAt: r.age } : {}),
		...(r.extra_snippets && r.extra_snippets.length > 0 ? { highlights: r.extra_snippets } : {}),
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
				include_raw_content: opts.includeRawContent ?? false,
				// Free (no extra cost, per Tavily's own docs) -- just adds a `usage`
				// field to the response reporting this one call's own credit cost.
				include_usage: true,
				...(opts.timeRange ? { time_range: opts.timeRange } : {}),
				...(opts.topic ? { topic: opts.topic } : {}),
				...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
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
			raw_content?: string;
		}>;
		usage?: { credits: number };
	};

	if (data.usage?.credits !== undefined) opts.onUsage?.({ credits: data.usage.credits });

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.content ?? "",
		...(r.published_date ? { publishedAt: r.published_date } : {}),
		...(r.raw_content ? { content: r.raw_content } : {}),
	}));
}

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
export async function tavilySearchForAnswer(query: string, opts: TavilyAnswerSearchOptions = {}): Promise<AnswerResult> {
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
				include_answer: opts.answerDepth ?? true,
				include_usage: true,
				...(opts.timeRange ? { time_range: opts.timeRange } : {}),
				...(opts.topic ? { topic: opts.topic } : {}),
				...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
			}),
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		answer?: string;
		results?: Array<{ url: string; title: string; content?: string; published_date?: string }>;
		usage?: { credits: number };
	};

	if (data.usage?.credits !== undefined) opts.onUsage?.({ credits: data.usage.credits });

	return {
		answer: data.answer ?? "",
		sources: (data.results ?? []).map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.content ?? "",
			...(r.published_date ? { publishedAt: r.published_date } : {}),
		})),
	};
}

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
			body: JSON.stringify({ q: withSiteFilter(query, opts.siteFilter), num: opts.numResults ?? 10 }),
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
export async function serpApiSearch(query: string, opts: SerpApiSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["SERPAPI_API_KEY"];
	if (!apiKey) throw new Error("SerpApi key required — set SERPAPI_API_KEY or pass opts.apiKey");

	const params = new URLSearchParams({
		engine: "google",
		q: withSiteFilter(query, opts.siteFilter),
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
export async function youComSearch(query: string, opts: YouComSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env["YOU_API_KEY"];
	if (!apiKey) throw new Error("You.com API key required — set YOU_API_KEY or pass opts.apiKey");

	const params = new URLSearchParams({
		query,
		count: String(opts.numResults ?? 10),
	});
	if (opts.siteFilter) params.set("include_domains", opts.siteFilter);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let res: Response;
	try {
		// api.ydc-index.io, not the bare ydc-index.io apex domain -- confirmed against
		// You.com's own docs/blog, its AWS Marketplace listing, and Databricks's
		// integration guide, all of which agree on the api. subdomain.
		res = await fetch(`https://api.ydc-index.io/v1/search?${params}`, {
			signal: controller.signal,
			headers: { "X-API-Key": apiKey, Accept: "application/json" },
		});
	} finally {
		clearTimeout(timer);
	}

	if (!res.ok) throw new Error(`You.com API error: ${res.status} ${res.statusText}`);

	const data = (await res.json()) as {
		results?: {
			web?: Array<{
				url: string;
				title: string;
				description?: string;
				snippets?: string[];
				page_age?: string;
			}>;
		};
	};

	return (data.results?.web ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.description ?? r.snippets?.[0] ?? "",
		...(r.page_age ? { publishedAt: r.page_age } : {}),
		...(r.snippets && r.snippets.length > 0 ? { highlights: r.snippets } : {}),
	}));
}

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
export async function webSearch(query: string, opts: WebSearchOptions & { wantAnswer: true }): Promise<AnswerResult>;
export async function webSearch(query: string, opts?: WebSearchOptions & { wantAnswer?: false }): Promise<WebSearchResult[]>;
export async function webSearch(
	query: string,
	opts: WebSearchOptions & { wantAnswer?: boolean } = {},
): Promise<WebSearchResult[] | AnswerResult> {
	const req: SearchQuery = {
		query,
		numResults: opts.numResults,
		timeRange: opts.timeRange,
		topic: opts.topic,
		siteFilter: opts.siteFilter,
	};

	if (opts.wantAnswer) {
		const answerEngine = opts.engine
			? resolveAnswerEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
			: defaultAnswerEngine();
		return answerEngine.searchForAnswer(req);
	}

	const engine = opts.engine
		? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
		: defaultSearchEngine();
	return engine.search({ ...req, wantFullContent: opts.wantFullContent });
}

// ---------------------------------------------------------------------------
// Engine registry — OCP: adding a new engine = one registerSearchEngine() call
// ---------------------------------------------------------------------------

/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines.
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
		you: "YOU_API_KEY",
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
registerSearchEngine("you", (key) => {
	if (!key) throw new Error("YOU_API_KEY not set");
	return new YouComSearchEngine(key);
});

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
	constructor(private readonly apiKey: string, private readonly country?: string, private readonly onUsage?: (usage: EngineUsage) => void, private readonly extraSnippets = true) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		const freshness = req.timeRange ? BRAVE_FRESHNESS[req.timeRange] : undefined;
		return braveSearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			country: this.country,
			freshness,
			siteFilter: req.siteFilter,
			onUsage: this.onUsage,
			extraSnippets: this.extraSnippets,
		});
	}
}

/** Tavily adapter implementing ISearchEngine and IAnswerSearchEngine (reference implementation of the answer-first port, via Tavily's own include_answer). */
export class TavilySearchEngine implements ISearchEngine, IAnswerSearchEngine {
	constructor(private readonly apiKey: string, private readonly onUsage?: (usage: EngineUsage) => void) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return tavilySearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			timeRange: req.timeRange,
			topic: req.topic,
			siteFilter: req.siteFilter,
			includeRawContent: req.wantFullContent,
			onUsage: this.onUsage,
		});
	}

	searchForAnswer(req: SearchQuery): Promise<AnswerResult> {
		return tavilySearchForAnswer(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			timeRange: req.timeRange,
			topic: req.topic,
			siteFilter: req.siteFilter,
			onUsage: this.onUsage,
		});
	}
}

/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string, private readonly onUsage?: (usage: EngineUsage) => void) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return exaSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter, onUsage: this.onUsage, includeText: req.wantFullContent });
	}
}

/** Serper.dev adapter implementing ISearchEngine. */
export class SerperSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serperSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
	}
}

/** SerpApi adapter implementing ISearchEngine. */
export class SerpApiSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serpApiSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
	}
}

/** You.com adapter implementing ISearchEngine. */
export class YouComSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return youComSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
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
 * // Tavily with Exa as a second-choice fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new ExaSearchEngine(process.env.EXA_API_KEY),
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
// SiteAvailabilityTracker — remembers which engine actually covers a site
// ---------------------------------------------------------------------------

export interface InMemorySiteAvailabilityTrackerOptions {
	/** Max distinct sites tracked; the oldest (by last-touched) is evicted first once exceeded. Default 500. */
	maxSites?: number;
	/** How long a "blocked" verdict (zero matching results) is trusted before that engine is worth retrying for the site. Default 24h -- long enough to stop re-paying the cost every call, short enough that a real policy change (a new licensing deal, e.g.) is eventually rediscovered. */
	blockedTtlMs?: number;
	/** Clock, injectable for tests. Defaults to Date.now. */
	now?: () => number;
}

interface SiteRecord {
	workingEngines: Set<string>;
	blockedUntil: Map<string, number>;
}

/**
 * Default {@link SiteAvailabilityTracker}: an in-memory, bounded map from
 * site to per-engine verdicts. Process-lifetime only -- a daemon wanting
 * cross-restart persistence injects its own implementation of the same
 * port (e.g. backed by its existing SQLite store) instead.
 */
export class InMemorySiteAvailabilityTracker implements SiteAvailabilityTracker {
	private readonly records = new Map<string, SiteRecord>();
	private readonly maxSites: number;
	private readonly blockedTtlMs: number;
	private readonly now: () => number;

	constructor(opts: InMemorySiteAvailabilityTrackerOptions = {}) {
		this.maxSites = opts.maxSites ?? 500;
		this.blockedTtlMs = opts.blockedTtlMs ?? 24 * 60 * 60_000;
		this.now = opts.now ?? Date.now;
	}

	recordAttempt(site: string, engineName: string, matched: boolean): void {
		const key = site.toLowerCase();
		let rec = this.records.get(key);
		if (rec) {
			this.records.delete(key); // refresh LRU position -- re-inserted below
		} else {
			if (this.records.size >= this.maxSites) {
				const oldest = this.records.keys().next().value;
				if (oldest !== undefined) this.records.delete(oldest);
			}
			rec = { workingEngines: new Set(), blockedUntil: new Map() };
		}
		if (matched) {
			rec.workingEngines.add(engineName);
			rec.blockedUntil.delete(engineName);
		} else {
			rec.blockedUntil.set(engineName, this.now() + this.blockedTtlMs);
		}
		this.records.set(key, rec);
	}

	order(site: string, engineNames: readonly string[]): string[] {
		const rec = this.records.get(site.toLowerCase());
		if (!rec) return [...engineNames];
		const now = this.now();
		const working: string[] = [];
		const untested: string[] = [];
		const blocked: string[] = [];
		for (const name of engineNames) {
			const blockedUntil = rec.blockedUntil.get(name);
			if (blockedUntil !== undefined && blockedUntil > now) blocked.push(name);
			else if (rec.workingEngines.has(name)) working.push(name);
			else untested.push(name);
		}
		return [...working, ...untested, ...blocked];
	}
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
export class SiteRoutedSearchEngine implements ISearchEngine {
	private readonly tracker: SiteAvailabilityTracker;

	constructor(
		private readonly engines: NamedSearchEngine[],
		private readonly plain: ISearchEngine,
		opts: SiteRoutedSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("SiteRoutedSearchEngine requires at least one engine");
		this.tracker = opts.tracker ?? new InMemorySiteAvailabilityTracker();
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		const site = (req.siteFilter ?? extractSiteFromQuery(req.query))?.toLowerCase();
		if (!site) return this.plain.search(req);

		const byName = new Map(this.engines.map((e) => [e.name, e] as const));
		const order = this.tracker.order(site, this.engines.map((e) => e.name));

		let lastError: unknown;
		let anySucceeded = false;
		for (const name of order) {
			const entry = byName.get(name);
			if (!entry) continue;
			try {
				const results = await entry.engine.search({ ...req, siteFilter: req.siteFilter ?? site });
				anySucceeded = true;
				const matching = results.filter((r) => hostMatchesSite(r.url, site));
				this.tracker.recordAttempt(site, name, matching.length > 0);
				if (matching.length > 0) return matching;
			} catch (err) {
				lastError = err;
				this.tracker.recordAttempt(site, name, false);
			}
		}

		if (!anySucceeded && lastError) throw lastError;
		return [];
	}
}

/** True when url's hostname is, or is a subdomain of, site. Invalid URLs never match rather than throwing. */
function hostMatchesSite(url: string, site: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === site || host.endsWith(`.${site}`);
	} catch {
		return false;
	}
}

/** Detects a `site:domain.tld` operator already present in raw query text, so a caller typing it directly (not via the structured siteFilter field) still benefits from tracked routing. */
function extractSiteFromQuery(query: string): string | undefined {
	return /\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/i.exec(query)?.[1]?.toLowerCase();
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
export class CapabilityRoutedSearchEngine implements ISearchEngine {
	constructor(
		private readonly engines: NamedSearchEngine[],
		private readonly plain: ISearchEngine,
	) {
		if (engines.length === 0) throw new Error("CapabilityRoutedSearchEngine requires at least one engine");
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		if (!req.wantFullContent) return this.plain.search(req);

		// A content-capable engine's own failure is never fatal here -- the
		// plain chain (tried next) may still satisfy the query, just without
		// content. Its error is the one that surfaces, since it's the last
		// and most complete attempt.
		for (const entry of this.engines.filter((e) => e.supportsFullContent)) {
			try {
				return await entry.engine.search(req);
			} catch {
				// try the next content-capable engine, then fall through to plain below
			}
		}

		return this.plain.search(req);
	}
}

// ---------------------------------------------------------------------------
// Wiring — compose engines from environment variables
// ---------------------------------------------------------------------------

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

/** Engines whose adapter maps {@link SearchQuery.wantFullContent} to a real vendor param (Tavily's include_raw_content, Exa's contents.text). Declared once here, not learned -- content support is a fixed vendor capability. */
const CONTENT_CAPABLE_ENGINES = new Set(["tavily", "exa"]);

/** No configured provider key at all -- the one error shared by every capability resolver (results, content, answer) when there's nothing to even consider. */
const NO_ENGINE_CONFIGURED_ERROR =
	"No search engine API key configured. Set one of BRAVE_SEARCH_API_KEY, " +
	"TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY, SERPAPI_API_KEY, or YOU_API_KEY.";

/** Every engine configured from environment keys, by real name, in a fixed declaration order (brave/tavily/exa/serper/serpapi/you) -- the single source of which adapters exist, shared by every capability resolver ({@link defaultSearchEngine}, {@link defaultAnswerEngine}) so they never drift out of sync with each other. */
function buildConfiguredEngines(env: Record<string, string | undefined>, onUsage?: (engineName: string, usage: EngineUsage) => void): { engines: ISearchEngine[]; names: string[] } {
	const engines: ISearchEngine[] = [];
	const names: string[] = [];

	const brave = env["BRAVE_SEARCH_API_KEY"];
	if (brave) { engines.push(new BraveSearchEngine(brave, undefined, onUsage ? (usage) => onUsage("brave", usage) : undefined)); names.push("brave"); }

	const tavily = env["TAVILY_API_KEY"];
	if (tavily) { engines.push(new TavilySearchEngine(tavily, onUsage ? (usage) => onUsage("tavily", usage) : undefined)); names.push("tavily"); }

	const exa = env["EXA_API_KEY"];
	if (exa) { engines.push(new ExaSearchEngine(exa, onUsage ? (usage) => onUsage("exa", usage) : undefined)); names.push("exa"); }

	const serper = env["SERPER_API_KEY"];
	if (serper) { engines.push(new SerperSearchEngine(serper)); names.push("serper"); }

	const serpapi = env["SERPAPI_API_KEY"];
	if (serpapi) { engines.push(new SerpApiSearchEngine(serpapi)); names.push("serpapi"); }

	const you = env["YOU_API_KEY"];
	if (you) { engines.push(new YouComSearchEngine(you)); names.push("you"); }

	return { engines, names };
}

/** True when engine implements {@link IAnswerSearchEngine} -- a structural capability check, not a name check. Whatever adapter satisfies this (today only TavilySearchEngine) is eligible for {@link defaultAnswerEngine}/wantAnswer with zero changes to either. */
function isAnswerCapable(engine: ISearchEngine): engine is ISearchEngine & IAnswerSearchEngine {
	return typeof (engine as Partial<IAnswerSearchEngine>).searchForAnswer === "function";
}

export function defaultSearchEngine(opts: DefaultSearchEngineOptions = {}): ISearchEngine {
	const env = opts.env ?? process.env;
	const { engines: rotationEngines, names: rotationNames } = buildConfiguredEngines(env, opts.onUsage);

	if (rotationEngines.length === 0) {
		throw new Error(NO_ENGINE_CONFIGURED_ERROR);
	}

	const namedEngines: NamedSearchEngine[] = rotationEngines.map((engine, i) => ({
		name: rotationNames[i] as string,
		engine,
		supportsFullContent: CONTENT_CAPABLE_ENGINES.has(rotationNames[i] as string),
	}));

	let plain: ISearchEngine;
	if (rotationEngines.length > 1) {
		plain = new RoundRobinSearchEngine(rotationEngines, {
			cooldownMs: opts.cooldownMs,
			quotaCooldownMs: opts.quotaCooldownMs,
			onEngineFailure: opts.onEngineFailure ? (index, error, reason) => opts.onEngineFailure?.(rotationNames[index] ?? `engine-${index}`, error, reason) : undefined,
		});
	} else {
		const soleName = rotationNames[0] as string;
		plain = new FallbackSearchEngine(rotationEngines, {
			cooldownMs: opts.cooldownMs,
			quotaCooldownMs: opts.quotaCooldownMs,
			onEngineFailure: opts.onEngineFailure ? (_index, error, reason) => opts.onEngineFailure?.(soleName, error, reason) : undefined,
		});
	}

	const contentAware = new CapabilityRoutedSearchEngine(namedEngines, plain);
	return new SiteRoutedSearchEngine(namedEngines, contentAware, { tracker: opts.siteAvailabilityTracker });
}

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
export function defaultAnswerEngine(opts: DefaultAnswerEngineOptions = {}): IAnswerSearchEngine {
	const env = opts.env ?? process.env;
	const { engines, names } = buildConfiguredEngines(env, opts.onUsage);

	const capable = engines
		.map((engine, i) => ({ engine, name: names[i] as string }))
		.filter((entry): entry is { engine: ISearchEngine & IAnswerSearchEngine; name: string } => isAnswerCapable(entry.engine));

	if (capable.length === 0) {
		if (engines.length === 0) throw new Error(NO_ENGINE_CONFIGURED_ERROR);
		throw new Error(
			`Configured search engine(s) (${names.join(", ")}) don't support answer synthesis (wantAnswer). ` +
				"Set TAVILY_API_KEY for a provider that does.",
		);
	}

	if (capable.length === 1) return (capable[0] as { engine: ISearchEngine & IAnswerSearchEngine }).engine;

	return {
		async searchForAnswer(req: SearchQuery): Promise<AnswerResult> {
			let lastError: unknown;
			for (const entry of capable) {
				try {
					return await entry.engine.searchForAnswer(req);
				} catch (err) {
					lastError = err;
				}
			}
			throw lastError;
		},
	};
}

/** Resolves a single named engine and asserts it supports wantAnswer, for webSearch's forced-engine path. Throws a clear, actionable error naming the engine rather than a generic type error when it doesn't. */
function resolveAnswerEngine(name: string, key: string | undefined): IAnswerSearchEngine {
	const engine = resolveSearchEngine(name, key);
	if (!isAnswerCapable(engine)) {
		throw new Error(`Engine "${name}" does not support wantAnswer (no searchForAnswer implementation). Currently only "tavily" does.`);
	}
	return engine;
}
