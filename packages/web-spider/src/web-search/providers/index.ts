/** Barrel of every ISearchEngine adapter -- one file per provider (Single Responsibility: adding a provider means adding a file here, never editing an existing one). */

export { BRAVE_FRESHNESS, BraveSearchEngine, type BraveSearchOptions, braveSearch } from "./brave.js";
export { BraveLlmContextSearchEngine, type BraveLlmContextSearchOptions, braveLlmContextSearch } from "./brave-llm.js";
export { ExaSearchEngine, type ExaSearchOptions, exaSearch } from "./exa.js";
export { SerpApiSearchEngine, type SerpApiSearchOptions, serpApiSearch } from "./serpapi.js";
export { SerperSearchEngine, type SerperSearchOptions, serperSearch } from "./serper.js";
export {
	type TavilyAnswerSearchOptions,
	TavilySearchEngine,
	type TavilySearchOptions,
	tavilySearch,
	tavilySearchForAnswer,
} from "./tavily.js";
export { YouComSearchEngine, type YouComSearchOptions, youComSearch } from "./you.js";
