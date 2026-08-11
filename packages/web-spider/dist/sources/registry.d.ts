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
/** A factory that creates a fresh ContentSourceStrategy instance on demand. */
export type ContentSourceFactory = () => ContentSourceStrategy;
/**
 * Register a content source strategy under a name — re-registering an
 * existing name overwrites it in place (same registration-order position),
 * everything else keeps working unchanged.
 *
 * @example
 * registerContentSource("my-site", () => myContentSource())
 */
export declare function registerContentSource(name: string, factory: ContentSourceFactory): void;
/** Every strategy name currently registered, in registration order. */
export declare function listRegisteredContentSources(): string[];
/**
 * Resolve specific strategies by name, in the order given (not registration
 * order) — for a caller that wants an explicit subset/ordering rather than
 * everything registered. Throws a descriptive error for an unknown name.
 */
export declare function resolveContentSources(names: readonly string[]): ContentSourceStrategy[];
/** Every registered strategy, instantiated fresh, in registration order. */
export declare function buildRegisteredContentSources(): ContentSourceStrategy[];
//# sourceMappingURL=registry.d.ts.map