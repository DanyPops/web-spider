/**
 * Web search API integration — every provider (Brave, Tavily, Exa, Serper,
 * SerpApi, You.com), the composite selection strategies (fallback,
 * round-robin, site/capability routing), and the engine registry each live
 * in their own file under this directory (providers/, composites/,
 * registry.ts, wiring.ts) -- this file is the package's public entrypoint:
 * the top-level webSearch() convenience function, plus a barrel re-export
 * of everything else so `from "./web-search/index.js"` still exposes the
 * full surface a caller had before this was one 1500+ line file.
 *
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY,
 *   SERPAPI_API_KEY, YOU_API_KEY
 */

// WebSearchResult is defined in ports.ts (the abstraction layer).
// web-search/ is an adapter layer — it imports from the port, not the other way.
export type { AnswerResult, EngineUsage, IAnswerSearchEngine, SiteAvailabilityTracker, WebSearchResult } from "../ports.js";

import type { AnswerResult, ISearchEngine, SearchQuery, WebSearchResult } from "../ports.js";
import { envKeyForEngine, resolveSearchEngine } from "./registry.js";
import { defaultAnswerEngine, defaultSearchEngine, resolveAnswerEngine } from "./wiring.js";

export * from "./composites/index.js";
export * from "./providers/index.js";
export { type EngineFactory, envKeyForEngine, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine } from "./registry.js";
export type { SearchEngine } from "./shared.js";
export {
	type DefaultAnswerEngineOptions,
	type DefaultSearchEngineOptions,
	defaultAnswerEngine,
	defaultSearchEngine,
} from "./wiring.js";

/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Throws when no provider key is configured — see
 * {@link defaultSearchEngine} for the "no engine configured" error shape.
 *
 * Prefer {@link defaultSearchEngine} + the fallback/round-robin composites
 * when you need composable retry / fallback behaviour.
 */
export interface WebSearchOptions {
	engine?: import("./shared.js").SearchEngine;
	numResults?: number;
	timeRange?: "day" | "week" | "month" | "year";
	topic?: "news" | "general";
	siteFilter?: string;
	/** See {@link SearchQuery.wantFullContent}. Ignored when wantAnswer is also set -- an answer-first call has no results list to attach content to. */
	wantFullContent?: boolean;
}

/**
 * wantAnswer: true -- resolves an answer-capable engine by capability (see
 * {@link defaultAnswerEngine}) and returns a synthesized {@link AnswerResult}
 * instead of a results list. The return type follows the declared want,
 * not which engine happens to serve it.
 */
export async function webSearch(query: string, opts: WebSearchOptions & { wantAnswer: true }): Promise<AnswerResult>;
export async function webSearch(query: string, opts?: WebSearchOptions & { wantAnswer?: false }): Promise<WebSearchResult[]>;
export async function webSearch(
	query: string,
	opts: WebSearchOptions & { wantAnswer?: boolean } = {},
): Promise<WebSearchResult[] | AnswerResult> {
	const req: SearchQuery = {
		query,
		numResults: opts.numResults,
		timeRange: opts.timeRange,
		topic: opts.topic,
		siteFilter: opts.siteFilter,
	};

	if (opts.wantAnswer) {
		const answerEngine = opts.engine ? resolveAnswerEngine(opts.engine, process.env[envKeyForEngine(opts.engine)]) : defaultAnswerEngine();
		return answerEngine.searchForAnswer(req);
	}

	const engine: ISearchEngine = opts.engine
		? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
		: defaultSearchEngine();
	return engine.search({ ...req, wantFullContent: opts.wantFullContent });
}
