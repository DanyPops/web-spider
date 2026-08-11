import { githubContentSource } from "./github.js";
import { llmsTxtContentSource } from "./llms-txt.js";
import { markdownSuffixContentSource } from "./markdown-suffix.js";
import { mediaWikiContentSource } from "./mediawiki.js";
import { youtubeContentSource } from "./youtube.js";
/** The global content source registry, in registration order. Seeded with built-ins below. */
const REGISTRY = [];
/**
 * Register a content source strategy under a name — re-registering an
 * existing name overwrites it in place (same registration-order position),
 * everything else keeps working unchanged.
 *
 * @example
 * registerContentSource("my-site", () => myContentSource())
 */
export function registerContentSource(name, factory) {
    const index = REGISTRY.findIndex((entry) => entry.name === name);
    if (index >= 0)
        REGISTRY[index] = { name, factory };
    else
        REGISTRY.push({ name, factory });
}
/** Every strategy name currently registered, in registration order. */
export function listRegisteredContentSources() {
    return REGISTRY.map((entry) => entry.name);
}
/**
 * Resolve specific strategies by name, in the order given (not registration
 * order) — for a caller that wants an explicit subset/ordering rather than
 * everything registered. Throws a descriptive error for an unknown name.
 */
export function resolveContentSources(names) {
    return names.map((name) => {
        const entry = REGISTRY.find((candidate) => candidate.name === name);
        if (!entry)
            throw new Error(`Unknown content source: "${name}". Register it with registerContentSource().`);
        return entry.factory();
    });
}
/** Every registered strategy, instantiated fresh, in registration order. */
export function buildRegisteredContentSources() {
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
//# sourceMappingURL=registry.js.map