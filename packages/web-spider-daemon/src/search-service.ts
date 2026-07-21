/**
 * Web search application service — daemon-owned so provider API keys are
 * read once from the daemon's own environment and never pass through the
 * client or get logged (design doc §6/trust-boundary note). Wraps
 * @danypops/web-spider's existing defaultSearchEngine()/resolveSearchEngine()
 * adapters rather than re-implementing provider calls.
 */
import { defaultSearchEngine, resolveSearchEngine, type ISearchEngine, type SearchEngine, type WebSearchResult } from "@danypops/web-spider";
import { SEARCH_DEFAULT_NUM_RESULTS, SEARCH_MAX_NUM_RESULTS_CEILING } from "./constants.ts";

export interface WebSearchInput {
	query: string;
	numResults?: number;
	timeRange?: "day" | "week" | "month" | "year";
	topic?: "news" | "general";
	/** Force a specific engine. Auto-detected from available API keys when omitted. */
	searchEngine?: SearchEngine;
}

export interface WebSearchOutput {
	query: string;
	results: WebSearchResult[];
}

export type EngineResolver = (name?: SearchEngine) => ISearchEngine;

/** Maps a forced engine name to the daemon-environment variable carrying its API key. DDG needs none. */
const ENGINE_ENV_VARS: Partial<Record<SearchEngine, string>> = {
	brave: "BRAVE_SEARCH_API_KEY",
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
};

/** Builds an EngineResolver reading API keys from the given environment (the daemon's own — never the client's). */
export function createEngineResolver(env: Record<string, string | undefined> = process.env): EngineResolver {
	return (name) => {
		if (!name) return defaultSearchEngine();
		const envVar = ENGINE_ENV_VARS[name];
		return resolveSearchEngine(name, envVar ? env[envVar] : undefined);
	};
}

function clampNumResults(requested: number | undefined): number {
	const value = Number.isFinite(requested) ? Math.floor(requested as number) : SEARCH_DEFAULT_NUM_RESULTS;
	return Math.max(1, Math.min(SEARCH_MAX_NUM_RESULTS_CEILING, value));
}

export class WebSearchService {
	constructor(private readonly resolveEngine: EngineResolver) {}

	async search(input: WebSearchInput): Promise<WebSearchOutput> {
		const query = input.query?.trim();
		if (!query) throw new Error("query is required");
		const engine = this.resolveEngine(input.searchEngine);
		const results = await engine.search({
			query,
			numResults: clampNumResults(input.numResults),
			timeRange: input.timeRange,
			topic: input.topic,
		});
		return { query, results };
	}
}
