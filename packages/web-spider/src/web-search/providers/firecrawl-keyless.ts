import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";

const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

/** Minimal Fetch-shaped transport seam for deterministic adapter tests. */
export type SearchTransport = (input: string, init?: RequestInit) => Promise<Response>;

export interface FirecrawlKeylessSearchOptions {
	transport?: SearchTransport;
	timeoutMs?: number;
	numResults?: number;
	timeRange?: SearchQuery["timeRange"];
	topic?: SearchQuery["topic"];
	siteFilter?: string;
}

interface FirecrawlResult {
	url?: unknown;
	title?: unknown;
	description?: unknown;
	snippet?: unknown;
	date?: unknown;
}

function timeRangeParameter(timeRange: SearchQuery["timeRange"]): string | undefined {
	const values: Partial<Record<NonNullable<SearchQuery["timeRange"]>, string>> = {
		day: "qdr:d",
		week: "qdr:w",
		month: "qdr:m",
		year: "qdr:y",
	};
	return timeRange ? values[timeRange] : undefined;
}

function normalizeResult(result: FirecrawlResult): WebSearchResult | undefined {
	if (typeof result.url !== "string" || typeof result.title !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(result.url);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const title = result.title.trim();
	if (!title) return undefined;
	const rawSnippet = typeof result.description === "string" ? result.description : typeof result.snippet === "string" ? result.snippet : "";
	const publishedAt = typeof result.date === "string" ? result.date.trim() : "";
	return {
		url: url.toString(),
		title,
		snippet: rawSnippet.trim(),
		...(publishedAt ? { publishedAt } : {}),
	};
}

function boundedResultCount(value: number | undefined): number {
	if (!Number.isFinite(value)) return MAX_RESULTS;
	return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value as number)));
}

function retrySuffix(response: Response): string {
	const retryAfter = response.headers.get("retry-after")?.trim();
	return retryAfter && /^\d{1,6}$/.test(retryAfter) ? ` — retry after ${retryAfter}s` : "";
}

/** Search Firecrawl's officially supported per-IP keyless fallback endpoint. */
export async function firecrawlKeylessSearch(query: string, options: FirecrawlKeylessSearchOptions = {}): Promise<WebSearchResult[]> {
	const transport = options.transport ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const source = options.topic === "news" ? "news" : "web";
	// Firecrawl documents tbs for web results only; it does not filter news.
	const tbs = source === "web" ? timeRangeParameter(options.timeRange) : undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await transport(FIRECRAWL_SEARCH_ENDPOINT, {
			method: "POST",
			redirect: "error",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				limit: boundedResultCount(options.numResults),
				sources: [source],
				highlights: false,
				...(tbs ? { tbs } : {}),
				...(options.siteFilter ? { includeDomains: [options.siteFilter] } : {}),
			}),
		});
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`Firecrawl keyless search timed out after ${timeoutMs}ms`, { cause: error });
		throw error;
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(`Firecrawl keyless search error: ${response.status} ${response.statusText}${retrySuffix(response)}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error("Firecrawl keyless search returned malformed JSON", { cause: error });
	}
	if (!payload || typeof payload !== "object" || (payload as { success?: unknown }).success !== true) {
		throw new Error("Firecrawl keyless search returned an unsuccessful payload");
	}
	const data = (payload as { data?: unknown }).data;
	if (!data || typeof data !== "object") throw new Error("Firecrawl keyless search returned a malformed payload");
	const results = (data as Record<string, unknown>)[source];
	if (!Array.isArray(results)) throw new Error("Firecrawl keyless search returned a malformed payload");
	return results
		.map((result) => normalizeResult(result as FirecrawlResult))
		.filter((result): result is WebSearchResult => result !== undefined);
}

/** Keyless Firecrawl adapter implementing the existing search Strategy port. */
export class FirecrawlKeylessSearchEngine implements ISearchEngine {
	constructor(private readonly options: Pick<FirecrawlKeylessSearchOptions, "transport" | "timeoutMs"> = {}) {}

	search(request: SearchQuery): Promise<WebSearchResult[]> {
		return firecrawlKeylessSearch(request.query, {
			...this.options,
			numResults: request.numResults,
			timeRange: request.timeRange,
			topic: request.topic,
			siteFilter: request.siteFilter,
		});
	}
}
