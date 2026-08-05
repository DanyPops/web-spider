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
export class CapabilityRoutedSearchEngine {
    constructor(engines, plain) {
        this.engines = engines;
        this.plain = plain;
        if (engines.length === 0)
            throw new Error("CapabilityRoutedSearchEngine requires at least one engine");
    }
    async search(req) {
        if (!req.wantFullContent)
            return this.plain.search(req);
        // A content-capable engine's own failure is never fatal here -- the
        // plain chain (tried next) may still satisfy the query, just without
        // content. Its error is the one that surfaces, since it's the last
        // and most complete attempt.
        for (const entry of this.engines.filter((e) => e.supportsFullContent)) {
            try {
                return await entry.engine.search(req);
            }
            catch {
                // try the next content-capable engine, then fall through to plain below
            }
        }
        return this.plain.search(req);
    }
}
//# sourceMappingURL=capability-routed.js.map