/**
 * Default {@link SiteAvailabilityTracker}: an in-memory, bounded map from
 * site to per-engine verdicts. Process-lifetime only -- a daemon wanting
 * cross-restart persistence injects its own implementation of the same
 * port (e.g. backed by its existing SQLite store) instead.
 */
export class InMemorySiteAvailabilityTracker {
    constructor(opts = {}) {
        this.records = new Map();
        this.maxSites = opts.maxSites ?? 500;
        this.blockedTtlMs = opts.blockedTtlMs ?? 24 * 60 * 60_000;
        this.now = opts.now ?? Date.now;
    }
    recordAttempt(site, engineName, matched) {
        const key = site.toLowerCase();
        let rec = this.records.get(key);
        if (rec) {
            this.records.delete(key); // refresh LRU position -- re-inserted below
        }
        else {
            if (this.records.size >= this.maxSites) {
                const oldest = this.records.keys().next().value;
                if (oldest !== undefined)
                    this.records.delete(oldest);
            }
            rec = { workingEngines: new Set(), blockedUntil: new Map() };
        }
        if (matched) {
            rec.workingEngines.add(engineName);
            rec.blockedUntil.delete(engineName);
        }
        else {
            rec.blockedUntil.set(engineName, this.now() + this.blockedTtlMs);
        }
        this.records.set(key, rec);
    }
    order(site, engineNames) {
        const rec = this.records.get(site.toLowerCase());
        if (!rec)
            return [...engineNames];
        const now = this.now();
        const working = [];
        const untested = [];
        const blocked = [];
        for (const name of engineNames) {
            const blockedUntil = rec.blockedUntil.get(name);
            if (blockedUntil !== undefined && blockedUntil > now)
                blocked.push(name);
            else if (rec.workingEngines.has(name))
                working.push(name);
            else
                untested.push(name);
        }
        return [...working, ...untested, ...blocked];
    }
}
/** True when url's hostname is, or is a subdomain of, site. Invalid URLs never match rather than throwing. */
export function hostMatchesSite(url, site) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === site || host.endsWith(`.${site}`);
    }
    catch {
        return false;
    }
}
/** Detects a `site:domain.tld` operator already present in raw query text, so a caller typing it directly (not via the structured siteFilter field) still benefits from tracked routing. */
export function extractSiteFromQuery(query) {
    return /\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/i.exec(query)?.[1]?.toLowerCase();
}
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
export class SiteRoutedSearchEngine {
    constructor(engines, plain, opts = {}) {
        this.engines = engines;
        this.plain = plain;
        if (engines.length === 0)
            throw new Error("SiteRoutedSearchEngine requires at least one engine");
        this.tracker = opts.tracker ?? new InMemorySiteAvailabilityTracker();
    }
    async search(req) {
        const site = (req.siteFilter ?? extractSiteFromQuery(req.query))?.toLowerCase();
        if (!site)
            return this.plain.search(req);
        const byName = new Map(this.engines.map((e) => [e.name, e]));
        const order = this.tracker.order(site, this.engines.map((e) => e.name));
        let lastError;
        let anySucceeded = false;
        for (const name of order) {
            const entry = byName.get(name);
            if (!entry)
                continue;
            try {
                const results = await entry.engine.search({ ...req, siteFilter: req.siteFilter ?? site });
                anySucceeded = true;
                const matching = results.filter((r) => hostMatchesSite(r.url, site));
                this.tracker.recordAttempt(site, name, matching.length > 0);
                if (matching.length > 0)
                    return matching;
            }
            catch (err) {
                lastError = err;
                this.tracker.recordAttempt(site, name, false);
            }
        }
        if (!anySucceeded && lastError)
            throw lastError;
        return [];
    }
}
//# sourceMappingURL=site-routed.js.map