import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import type { NamedSearchEngine } from "./site-routed.js";
/**
 * Wraps a set of named engines plus a plain fallback/rotation engine.
 * Realizes {@link SearchQuery.wantFullContent} as routing, not just a
 * per-adapter hint: a caller declares the *want*, this decides *who*
 * satisfies it, by capability rather than by name -- the same principle
 * {@link import("./site-routed.js").SiteRoutedSearchEngine} already applies to domain coverage.
 *
 * When wantFullContent is set, tries engines with
 * {@link NamedSearchEngine.supportsFullContent} first, in order, before
 * falling through to the plain chain -- so a content-capable engine is
 * preferred over whichever the round-robin's cursor happens to land on.
 * Falls through to plain (not a throw) when no content-capable engine is
 * configured at all, or every one of them fails: a declared want that
 * can't be satisfied should degrade to an ordinary result, not fail the
 * whole query, mirroring how an unsupported timeRange/topic is silently
 * ignored rather than rejected.
 *
 * Delegates straight to plain, untouched, when wantFullContent isn't set --
 * this composite only ever activates for that one declared intent.
 */
export declare class CapabilityRoutedSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly plain;
    constructor(engines: NamedSearchEngine[], plain: ISearchEngine);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=capability-routed.d.ts.map