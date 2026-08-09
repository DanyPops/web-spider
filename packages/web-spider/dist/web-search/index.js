/**
 * Web search API integration — every provider (Brave, Tavily, Exa, Serper,
 * SerpApi, You.com, Firecrawl keyless), the composite selection strategies (fallback,
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
import { envKeyForEngine, resolveSearchEngine } from "./registry.js";
import { defaultAnswerEngine, defaultSearchEngine, resolveAnswerEngine } from "./wiring.js";
export * from "./composites/index.js";
export * from "./providers/index.js";
export { envKeyForEngine, listRegisteredSearchEngines, registerSearchEngine, resolveSearchEngine } from "./registry.js";
export { defaultAnswerEngine, defaultSearchEngine, } from "./wiring.js";
export async function webSearch(query, opts = {}) {
    const req = {
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
    const engine = opts.engine
        ? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
        : defaultSearchEngine();
    return engine.search({ ...req, wantFullContent: opts.wantFullContent });
}
//# sourceMappingURL=index.js.map