import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { RATE_LIMIT_HEADER_PATTERN, withSiteFilter } from "../shared.js";

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

/** Maps the canonical timeRange string to Brave's freshness parameter. Reused by the Brave LLM Context adapter, which shares the same freshness vocabulary. */
export const BRAVE_FRESHNESS: Record<string, "pd" | "pw" | "pm" | "py"> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export async function braveSearch(query: string, opts: BraveSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
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

/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine implements ISearchEngine {
	constructor(
		private readonly apiKey: string,
		private readonly country?: string,
		private readonly onUsage?: (usage: EngineUsage) => void,
		private readonly extraSnippets = true,
	) {}

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
