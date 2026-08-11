/**
 * ContentSourceStrategy registry — the same OCP shape as the web-search
 * engine registry (../web-search/registry.ts): adding a new site adapter
 * becomes one `registerContentSource()` call, not an edit to `spider()`.
 *
 * Unlike the search engine registry (resolved one at a time, by explicit
 * name, per call), content sources are tried in *order* against a URL that
 * doesn't announce which one applies — the registry is therefore an
 * ordered list, not a bare name->factory map, and callers typically ask for
 * "every registered strategy, in registration order" ({@link
 * buildRegisteredContentSources}) rather than resolving a single name.
 * Explicit name-based resolution ({@link resolveContentSources}) is still
 * available for a caller (e.g. a daemon exposing a `sources: string[]`
 * option) that wants to pick a subset by name.
 */
import type { ContentSourceStrategy } from "./content-source.js";
import { githubContentSource } from "./github.js";
import { llmsTxtContentSource } from "./llms-txt.js";
import { markdownSuffixContentSource } from "./markdown-suffix.js";
import { mediaWikiContentSource } from "./mediawiki.js";
import { youtubeContentSource } from "./youtube.js";

/** A factory that creates a fresh ContentSourceStrategy instance on demand. */
export type ContentSourceFactory = () => ContentSourceStrategy;

interface RegistryEntry {
	name: string;
	factory: ContentSourceFactory;
}

/** The global content source registry, in registration order. Seeded with built-ins below. */
const REGISTRY: RegistryEntry[] = [];

/**
 * Register a content source strategy under a name — re-registering an
 * existing name overwrites it in place (same registration-order position),
 * everything else keeps working unchanged.
 *
 * @example
 * registerContentSource("my-site", () => myContentSource())
 */
export function registerContentSource(name: string, factory: ContentSourceFactory): void {
	const index = REGISTRY.findIndex((entry) => entry.name === name);
	if (index >= 0) REGISTRY[index] = { name, factory };
	else REGISTRY.push({ name, factory });
}

/** Every strategy name currently registered, in registration order. */
export function listRegisteredContentSources(): string[] {
	return REGISTRY.map((entry) => entry.name);
}

/**
 * Resolve specific strategies by name, in the order given (not registration
 * order) — for a caller that wants an explicit subset/ordering rather than
 * everything registered. Throws a descriptive error for an unknown name.
 */
export function resolveContentSources(names: readonly string[]): ContentSourceStrategy[] {
	return names.map((name) => {
		const entry = REGISTRY.find((candidate) => candidate.name === name);
		if (!entry) throw new Error(`Unknown content source: "${name}". Register it with registerContentSource().`);
		return entry.factory();
	});
}

/** Every registered strategy, instantiated fresh, in registration order. */
export function buildRegisteredContentSources(): ContentSourceStrategy[] {
	return REGISTRY.map((entry) => entry.factory());
}

// Seed the registry with built-ins, in the same order spider()'s legacy
// preferLlmsTxt/preferMarkdownVariant/preferGitHub/preferMediaWiki flags
// already apply them. Adding a new one: call registerContentSource() —
// do NOT edit this block for a third-party/local addition.
registerContentSource("llms-txt", () => llmsTxtContentSource());
registerContentSource("markdown-suffix", () => markdownSuffixContentSource());
registerContentSource("github", () => githubContentSource());
registerContentSource("mediawiki", () => mediaWikiContentSource());
registerContentSource("youtube", () => youtubeContentSource());
