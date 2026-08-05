import type { EngineUsage, ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { RATE_LIMIT_HEADER_PATTERN, withSiteFilter } from "../shared.js";
import { BRAVE_FRESHNESS } from "./brave.js";

export interface BraveLlmContextSearchOptions {
	/** API key. Defaults to process.env.BRAVE_SEARCH_API_KEY -- same subscription token as classic Brave web search. */
	apiKey?: string;
	/** Number of URLs to return (1-50). Maps to both Brave's own `count` (candidate pool) and `maximum_number_of_urls` (response cap) -- one dial instead of two, since a caller asking for N results has no reason to reason about both separately. Default 20 (Brave's own default) when omitted. */
	numResults?: number;
	/** ISO 3166-1 alpha-2 country code for localised results, e.g. "US". */
	country?: string;
	/** Freshness filter -- same pd/pw/pm/py values as classic Brave search. */
	freshness?: "pd" | "pw" | "pm" | "py";
	/** Restrict results to one domain. No native domain-filter param on this endpoint -- appended as a `site:` operator, same as classic Brave. */
	siteFilter?: string;
	/** Relevance-filtering aggressiveness. Default "balanced" (Brave's own default) when omitted. */
	contextThresholdMode?: "strict" | "balanced" | "lenient" | "disabled";
	/** Maximum tokens per URL (512-8192, Brave's own default 4096). Raised when honouring {@link SearchQuery.wantFullContent} -- this endpoint has no literal "full page content" toggle, so a larger per-URL token budget is the closest fit for that intent. */
	maxTokensPerUrl?: number;
	/** Called once with any rate-limit/quota-shaped response headers Brave sent -- same convention as {@link import("./brave.js").BraveSearchOptions.onUsage}. */
	onUsage?: (usage: EngineUsage) => void;
}

/**
 * Search the web via Brave's LLM Context API -- pre-extracted, chunked page
 * content purpose-built for AI agents/RAG, distinct from {@link import("./brave.js").braveSearch}'s
 * classic SERP-shaped endpoint.
 * https://api-dashboard.search.brave.com/documentation/services/llm-context
 */
export async function braveLlmContextSearch(query: string, opts: BraveLlmContextSearchOptions = {}): Promise<WebSearchResult[]> {
	const apiKey = opts.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
	if (!apiKey) throw new Error("Brave Search API key required — set BRAVE_SEARCH_API_KEY or pass opts.apiKey");

	const count = opts.numResults ? Math.min(opts.numResults, 50) : undefined;
	const params = new URLSearchParams({ q: withSiteFilter(query, opts.siteFilter) });
	if (count) {
		params.set("count", String(count));
		params.set("maximum_number_of_urls", String(count));
	}
	if (opts.country) params.set("country", opts.country);
	if (opts.freshness) params.set("freshness", opts.freshness);
	if (opts.contextThresholdMode) params.set("context_threshold_mode", opts.contextThresholdMode);
	if (opts.maxTokensPerUrl) params.set("maximum_number_of_tokens_per_url", String(opts.maxTokensPerUrl));

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	let res: Response;
	try {
		res = await fetch(`https://api.search.brave.com/res/v1/llm/context?${params}`, {
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

	if (!res.ok) throw new Error(`Brave LLM Context API error: ${res.status} ${res.statusText}`);

	const rateLimitHeaders: Record<string, string> = {};
	for (const [name, value] of res.headers.entries()) {
		if (RATE_LIMIT_HEADER_PATTERN.test(name)) rateLimitHeaders[name] = value;
	}
	if (Object.keys(rateLimitHeaders).length > 0) opts.onUsage?.({ rateLimitHeaders });

	const data = (await res.json()) as {
		grounding?: {
			generic?: Array<{ url: string; title: string; snippets?: string[] }>;
		};
		sources?: Record<string, { title?: string; hostname?: string; age?: (string | null)[] | null }>;
	};

	return (data.grounding?.generic ?? []).map((r) => {
		const publishedAt = data.sources?.[r.url]?.age?.[0];
		return {
			url: r.url,
			title: r.title,
			snippet: r.snippets?.[0] ?? "",
			...(publishedAt ? { publishedAt } : {}),
			...(r.snippets && r.snippets.length > 1 ? { highlights: r.snippets.slice(1) } : {}),
		};
	});
}

/**
 * Brave LLM Context adapter implementing ISearchEngine -- distinct from
 * {@link import("./brave.js").BraveSearchEngine}, which hits Brave's classic SERP endpoint.
 * Registered under "brave-llm", not folded into "brave": both read the same
 * BRAVE_SEARCH_API_KEY subscription token, so a caller opts in explicitly
 * (resolveSearchEngine/webSearch({engine: "brave-llm"})) instead of this
 * variant silently doubling Brave's share of defaultSearchEngine's
 * auto-detected round-robin rotation for every existing BRAVE_SEARCH_API_KEY
 * setup.
 */
export class BraveLlmContextSearchEngine implements ISearchEngine {
	constructor(
		private readonly apiKey: string,
		private readonly onUsage?: (usage: EngineUsage) => void,
	) {}

	search(req: SearchQuery): Promise<WebSearchResult[]> {
		return braveLlmContextSearch(req.query, {
			apiKey: this.apiKey,
			numResults: req.numResults,
			siteFilter: req.siteFilter,
			freshness: req.timeRange ? BRAVE_FRESHNESS[req.timeRange] : undefined,
			maxTokensPerUrl: req.wantFullContent ? 8192 : undefined,
			onUsage: this.onUsage,
		});
	}
}
