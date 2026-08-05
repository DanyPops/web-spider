import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { withSiteFilter } from "../shared.js";

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
	const apiKey = opts.apiKey ?? process.env.SERPER_API_KEY;
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

/** Serper.dev adapter implementing ISearchEngine. */
export class SerperSearchEngine implements ISearchEngine {
	constructor(private readonly apiKey: string) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return serperSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
	}
}
