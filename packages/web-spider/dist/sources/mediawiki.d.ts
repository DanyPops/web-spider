/**
 * MediaWiki API strategy — query the platform's real API for an article's
 * content instead of scraping the rendered wiki page (nav/sidebar/search-box
 * chrome that Readability would otherwise need to strip). Covers Wikipedia
 * and every other MediaWiki-based wiki: Wiktionary, Wikisource, Fandom
 * wikis, ArchWiki, Gentoo Wiki, and any self-hosted instance.
 *
 * Two real gotchas found by testing against actual live wikis, not assumed:
 *
 * 1. The API script path is not always /w/api.php. Wikipedia and most
 *    Wikimedia projects use /w/api.php; ArchWiki (a real, common,
 *    self-hosted instance) uses /api.php directly at the root. Both are
 *    tried, in that order.
 * 2. prop=extracts (clean plain-text via the TextExtracts extension) works
 *    on Wikipedia but is NOT installed on ArchWiki -- confirmed directly
 *    ("Unrecognized value for parameter \"prop\": extracts"). This module
 *    uses action=parse&prop=text instead: core MediaWiki, always available,
 *    returns the article's own rendered HTML (no page chrome), which is
 *    then run through this package's existing HTML->markdown pipeline
 *    exactly like a normal fetch.
 *
 * Also verified: redirects=1 is required on both action=query and
 * action=parse, or a redirect page (e.g. Wikipedia's "Dogfooding" ->
 * "Eating your own dog food") silently returns empty content instead of
 * following through.
 */
import type { IHttpClient } from "../ports.js";
export interface MediaWikiProbeOptions {
    /** ms before aborting each probe/query request (default 10 000). */
    timeoutMs?: number;
    userAgent?: string;
}
export interface MediaWikiSiteInfo {
    /** The working api.php URL for this wiki, e.g. "https://en.wikipedia.org/w/api.php". */
    apiUrl: string;
    siteName: string;
    /** Raw generator string from siteinfo, e.g. "MediaWiki 1.47.0-wmf.11". */
    generator: string;
}
export interface MediaWikiPageResult {
    /** The resolved title (may differ from the requested one if it was a redirect). */
    title: string;
    /** Rendered article content HTML (no page chrome) from action=parse. */
    html: string;
}
/**
 * Extracts the wiki page title from an article URL. Handles the /wiki/<Title>
 * (Wikipedia and most installs), /title/<Title> (ArchWiki and others), and
 * /index.php/<Title> path conventions, plus ?title=<Title> query-string
 * based configs. Returns null for URLs that don't look like a specific
 * article (bare site root, Special: pages handled the same as any other
 * title -- MediaWiki's own API resolves those correctly).
 */
export declare function extractWikiPageTitle(url: string): string | null;
/**
 * Probes a URL's origin for a working MediaWiki API endpoint. Tries
 * /w/api.php then /api.php; returns null if neither responds with a real
 * MediaWiki siteinfo (guards against a site that happens to have an
 * unrelated api.php file, or a soft-404 that returns 200 with something
 * that isn't valid siteinfo JSON at all).
 */
export declare function detectMediaWiki(url: string, httpClient: IHttpClient, options?: MediaWikiProbeOptions): Promise<MediaWikiSiteInfo | null>;
/**
 * Queries a specific page's rendered content HTML via action=parse. Returns
 * null on any API-level error (missing page, malformed response) rather
 * than throwing -- callers fall through to the normal fetch path on a miss.
 */
export declare function queryMediaWikiPage(apiUrl: string, pageTitle: string, httpClient: IHttpClient, options?: MediaWikiProbeOptions): Promise<MediaWikiPageResult | null>;
//# sourceMappingURL=mediawiki.d.ts.map