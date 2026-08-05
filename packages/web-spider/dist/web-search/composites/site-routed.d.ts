import type { ISearchEngine, SearchQuery, SiteAvailabilityTracker, WebSearchResult } from "../../ports.js";
export interface InMemorySiteAvailabilityTrackerOptions {
    /** Max distinct sites tracked; the oldest (by last-touched) is evicted first once exceeded. Default 500. */
    maxSites?: number;
    /** How long a "blocked" verdict (zero matching results) is trusted before that engine is worth retrying for the site. Default 24h -- long enough to stop re-paying the cost every call, short enough that a real policy change (a new licensing deal, e.g.) is eventually rediscovered. */
    blockedTtlMs?: number;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
}
/**
 * Default {@link SiteAvailabilityTracker}: an in-memory, bounded map from
 * site to per-engine verdicts. Process-lifetime only -- a daemon wanting
 * cross-restart persistence injects its own implementation of the same
 * port (e.g. backed by its existing SQLite store) instead.
 */
export declare class InMemorySiteAvailabilityTracker implements SiteAvailabilityTracker {
    private readonly records;
    private readonly maxSites;
    private readonly blockedTtlMs;
    private readonly now;
    constructor(opts?: InMemorySiteAvailabilityTrackerOptions);
    recordAttempt(site: string, engineName: string, matched: boolean): void;
    order(site: string, engineNames: readonly string[]): string[];
}
export interface NamedSearchEngine {
    name: string;
    engine: ISearchEngine;
    /**
     * True when this engine can honour {@link SearchQuery.wantFullContent}
     * (Tavily, Exa). Declared once at wiring time rather than learned --
     * unlike per-site coverage, content support is a fixed vendor capability,
     * not something that needs discovering empirically per call.
     */
    supportsFullContent?: boolean;
}
export interface SiteRoutedSearchEngineOptions {
    /** Defaults to a fresh InMemorySiteAvailabilityTracker. */
    tracker?: SiteAvailabilityTracker;
}
/** True when url's hostname is, or is a subdomain of, site. Invalid URLs never match rather than throwing. */
export declare function hostMatchesSite(url: string, site: string): boolean;
/** Detects a `site:domain.tld` operator already present in raw query text, so a caller typing it directly (not via the structured siteFilter field) still benefits from tracked routing. */
export declare function extractSiteFromQuery(query: string): string | undefined;
/**
 * Wraps a set of named engines plus a plain fallback/rotation engine. For a
 * site-filtered query (SearchQuery.siteFilter, or a `site:domain` operator
 * detected in the raw query text) it tries the named engines in an order
 * informed by which have actually returned matching results for that site
 * before -- known-working first, untested next, recently-verified-blocked
 * last -- filtering each engine's raw results down to ones that genuinely
 * match the requested domain (an engine that ignores the filter entirely,
 * or has no real crawl coverage of the site, reports zero matches rather
 * than off-topic results). Every attempt updates the tracker, so a real
 * block (e.g. Reddit's 2024 robots.txt change locking out every search
 * engine but Google-backed ones) is learned once per site instead of
 * re-paid on every subsequent call -- while the verdict still expires
 * (see {@link InMemorySiteAvailabilityTrackerOptions.blockedTtlMs}), so a
 * later-fixed engine gets retried instead of being written off forever.
 *
 * Falls straight through to the plain engine, untouched, for a query with
 * no site filter -- this composite only ever activates for domain-
 * restricted queries.
 */
export declare class SiteRoutedSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly plain;
    private readonly tracker;
    constructor(engines: NamedSearchEngine[], plain: ISearchEngine, opts?: SiteRoutedSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=site-routed.d.ts.map