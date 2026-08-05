import type { ISearchEngine } from "../ports.js";
/**
 * A factory that creates an ISearchEngine from an optional API key.
 * key is undefined for keyless engines.
 */
export type EngineFactory = (key: string | undefined) => ISearchEngine;
/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export declare function registerSearchEngine(name: string, factory: EngineFactory): void;
/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export declare function resolveSearchEngine(name: string, key?: string | undefined): ISearchEngine;
/** Every engine name currently registered -- a consumer that needs to iterate all known backends (e.g. a local credential store) never hardcodes a second copy of this list. */
export declare function listRegisteredSearchEngines(): string[];
/** Map an engine name to its env var key name (for webSearch auto-detect, and for anything else that needs the same canonical mapping). Returns "" for an unknown name. */
export declare function envKeyForEngine(name: string): string;
//# sourceMappingURL=registry.d.ts.map