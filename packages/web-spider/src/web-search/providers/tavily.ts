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
export async function tavilySearch(query: string, opts: TavilySearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
	if (!apiKey) throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				query,
				max_results: opts.numResults ?? 5,
				search_depth: opts.depth ?? "basic",
				include_raw_content: opts.includeRawContent ?? false,
				// Free (no extra cost, per Tavily's own docs) -- just adds a `usage`
				// field to the response reporting this one call's own credit cost.
				include_usage: true,
				...(opts.timeRange ? { time_range: opts.timeRange } : {}),
				...(opts.topic ? { topic: opts.topic } : {}),
				...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
				...(opts.excludeDomains && opts.excludeDomains.length > 0 ? { exclude_domains: opts.excludeDomains } : {}),
				...(opts.includeFavicon ? { include_favicon: opts.includeFavicon } : {}),
				...(opts.country ? { country: opts.country } : {}),
				...(opts.startDate ? { start_date: opts.startDate } : {}),
				...(opts.endDate ? { end_date: opts.endDate } : {}),
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
	const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
	if (!apiKey) throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	let res: Response;
	try {
		res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				query,
				max_results: opts.numResults ?? 5,
				search_depth: opts.depth ?? "basic",
				include_answer: opts.answerDepth ?? true,
				include_usage: true,
				...(opts.timeRange ? { time_range: opts.timeRange } : {}),
				...(opts.topic ? { topic: opts.topic } : {}),
				...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
				...(opts.excludeDomains && opts.excludeDomains.length > 0 ? { exclude_domains: opts.excludeDomains } : {}),
				...(opts.includeFavicon ? { include_favicon: opts.includeFavicon } : {}),
				...(opts.country ? { country: opts.country } : {}),
				...(opts.startDate ? { start_date: opts.startDate } : {}),
				...(opts.endDate ? { end_date: opts.endDate } : {}),
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

/** Tavily adapter implementing ISearchEngine and IAnswerSearchEngine (reference implementation of the answer-first port, via Tavily's own include_answer). */
export class TavilySearchEngine implements ISearchEngine, IAnswerSearchEngine {
	constructor(
		private readonly apiKey: string,
		private readonly onUsage?: (usage: EngineUsage) => void,
	) {}

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
