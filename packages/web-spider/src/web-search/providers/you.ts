import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";

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
	const apiKey = opts.apiKey ?? process.env.YOU_API_KEY;
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

/** You.com adapter implementing ISearchEngine. */
export class YouComSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return youComSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
	}
}
