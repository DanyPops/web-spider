import type { ISearchEngine } from "../ports.js";
import {
	BraveLlmContextSearchEngine,
	BraveSearchEngine,
	ExaSearchEngine,
	SerpApiSearchEngine,
	SerperSearchEngine,
	TavilySearchEngine,
	YouComSearchEngine,
} from "./providers/index.js";

// ---------------------------------------------------------------------------
// Engine registry — OCP: adding a new engine = one registerSearchEngine() call
// ---------------------------------------------------------------------------

/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines.
 */
export type EngineFactory = (key: string | undefined) => ISearchEngine;

/** The global engine registry. Seeded with built-in engines below. */
const ENGINE_REGISTRY = new Map<string, EngineFactory>();

/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export function registerSearchEngine(name: string, factory: EngineFactory): void {
	ENGINE_REGISTRY.set(name, factory);
}

/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export function resolveSearchEngine(name: string, key?: string | undefined): ISearchEngine {
	const factory = ENGINE_REGISTRY.get(name);
	if (!factory) throw new Error(`Unknown search engine: "${name}". Register it with registerSearchEngine().`);
	return factory(key);
}

/** Every engine name currently registered -- a consumer that needs to iterate all known backends (e.g. a local credential store) never hardcodes a second copy of this list. */
export function listRegisteredSearchEngines(): string[] {
	return [...ENGINE_REGISTRY.keys()];
}

/** Map an engine name to its env var key name (for webSearch auto-detect, and for anything else that needs the same canonical mapping). Returns "" for an unknown name. */
export function envKeyForEngine(name: string): string {
	const envKeys: Record<string, string> = {
		brave: "BRAVE_SEARCH_API_KEY",
		"brave-llm": "BRAVE_SEARCH_API_KEY",
		tavily: "TAVILY_API_KEY",
		exa: "EXA_API_KEY",
		serper: "SERPER_API_KEY",
		serpapi: "SERPAPI_API_KEY",
		you: "YOU_API_KEY",
	};
	return envKeys[name] ?? "";
}

// Seed the registry with built-in engines.
// Adding a new engine: call registerSearchEngine() — do NOT edit this block.
registerSearchEngine("brave", (key) => {
	if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
	return new BraveSearchEngine(key);
});
registerSearchEngine("brave-llm", (key) => {
	if (!key) throw new Error("BRAVE_SEARCH_API_KEY not set");
	return new BraveLlmContextSearchEngine(key);
});
registerSearchEngine("tavily", (key) => {
	if (!key) throw new Error("TAVILY_API_KEY not set");
	return new TavilySearchEngine(key);
});
registerSearchEngine("exa", (key) => {
	if (!key) throw new Error("EXA_API_KEY not set");
	return new ExaSearchEngine(key);
});
registerSearchEngine("serper", (key) => {
	if (!key) throw new Error("SERPER_API_KEY not set");
	return new SerperSearchEngine(key);
});
registerSearchEngine("serpapi", (key) => {
	if (!key) throw new Error("SERPAPI_API_KEY not set");
	return new SerpApiSearchEngine(key);
});
registerSearchEngine("you", (key) => {
	if (!key) throw new Error("YOU_API_KEY not set");
	return new YouComSearchEngine(key);
});
