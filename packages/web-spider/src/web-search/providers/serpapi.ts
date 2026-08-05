import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { withSiteFilter } from "../shared.js";

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
	const apiKey = opts.apiKey ?? process.env.SERPAPI_API_KEY;
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

/** SerpApi adapter implementing ISearchEngine. */
export class SerpApiSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serpApiSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
	}
}
