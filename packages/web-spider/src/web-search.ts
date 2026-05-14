/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */

export interface WebSearchResult {
	url: string;
	title: string;
	/** Short description / snippet from the search engine. */
	snippet: string;
	/** ISO-8601 or human-readable date, if the engine returned one. */
	publishedAt?: string;
}

export interface BraveSearchOptions {
	/** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY. */
	apiKey?: string;
	/** Number of results (1–20). Default 10. */
	numResults?: number;
	/** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
	country?: string;
}

export interface TavilySearchOptions {
	/** API key. Defaults to process.env.TAVILY_API_KEY. */
	apiKey?: string;
	/** Number of results. Default 5. */
	numResults?: number;
	/** "basic" (1 credit) or "advanced" (2 credits). Default "basic". */
	depth?: "basic" | "advanced";
}

export type SearchEngine = "brave" | "tavily";

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
	};

	return (data.results ?? []).map((r) => ({
		url: r.url,
		title: r.title,
		snippet: r.content ?? "",
		...(r.published_date ? { publishedAt: r.published_date } : {}),
	}));
}

/**
 * Search using whichever engine has an API key available.
 * Tries Brave first, then Tavily, throws if neither is configured.
 */
export async function webSearch(
	query: string,
	opts: { engine?: SearchEngine; numResults?: number } = {},
): Promise<WebSearchResult[]> {
	const engine =
		opts.engine ??
		(process.env["BRAVE_SEARCH_API_KEY"] ? "brave" : process.env["TAVILY_API_KEY"] ? "tavily" : null);

	if (!engine) {
		throw new Error(
			"No search API key found. Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY.",
		);
	}

	return engine === "brave"
		? braveSearch(query, { numResults: opts.numResults })
		: tavilySearch(query, { numResults: opts.numResults });
}
