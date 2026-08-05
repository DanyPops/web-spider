import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";

export interface ExaSearchOptions {
	/** API key. Defaults to process.env.EXA_API_KEY. */
	apiKey?: string;
	/** Number of results. Default 10. */
	numResults?: number;
	/**
	 * Search type -- a latency/quality dial, per Exa's own OpenAPI spec
	 * (exa-labs/openapi-spec): "neural" | "fast" | "auto" | "deep" |
	 * "deep-reasoning" | "instant". "keyword" is no longer a valid value --
	 * dropped, not aliased, since sending it now gets a 400 from Exa rather
	 * than silently degrading.
	 *
	 * "auto"           — Exa decides keyword vs neural (default).
	 * "neural"         — embeddings-based semantic search.
	 * "fast"           — streamlined versions of the search models, ~450ms.
	 * "instant"        — lowest latency, optimised for real-time apps, ~250ms.
	 * "deep"           — light deep search: multi-step, structured output.
	 * "deep-reasoning" — base deep search, more reasoning, 12-40s.
	 */
	type?: "auto" | "neural" | "fast" | "instant" | "deep" | "deep-reasoning";
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
	const apiKey = opts.apiKey ?? process.env.EXA_API_KEY;
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

/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine implements ISearchEngine {
	constructor(
		private readonly apiKey: string,
		private readonly onUsage?: (usage: EngineUsage) => void,
	) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return exaSearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			siteFilter: req.siteFilter,
			onUsage: this.onUsage,
			includeText: req.wantFullContent,
		});
	}
}
