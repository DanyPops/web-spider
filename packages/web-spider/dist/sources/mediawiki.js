const API_PATH_CANDIDATES = ["/w/api.php", "/api.php"];
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
async function fetchJson(url, httpClient, timeoutMs, userAgent) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await httpClient.fetch({
            url,
            signal: controller.signal,
            headers: { "User-Agent": userAgent, Accept: "application/json" },
        });
        if (!res.ok)
            return null;
        const contentType = res.headers.get("content-type");
        if (contentType && !contentType.toLowerCase().includes("json"))
            return null;
        const body = await res.text();
        try {
            return JSON.parse(body);
        }
        catch {
            return null;
        }
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Extracts the wiki page title from an article URL. Handles the /wiki/<Title>
 * (Wikipedia and most installs), /title/<Title> (ArchWiki and others), and
 * /index.php/<Title> path conventions, plus ?title=<Title> query-string
 * based configs. Returns null for URLs that don't look like a specific
 * article (bare site root, Special: pages handled the same as any other
 * title -- MediaWiki's own API resolves those correctly).
 */
export function extractWikiPageTitle(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    const titleParam = parsed.searchParams.get("title");
    if (titleParam)
        return titleParam;
    const match = /\/(?:wiki|title)\/([^?#]+)/.exec(parsed.pathname) ?? /\/index\.php\/([^?#]+)/.exec(parsed.pathname);
    if (!match?.[1])
        return null;
    try {
        return decodeURIComponent(match[1]);
    }
    catch {
        return null;
    }
}
/**
 * Probes a URL's origin for a working MediaWiki API endpoint. Tries
 * /w/api.php then /api.php; returns null if neither responds with a real
 * MediaWiki siteinfo (guards against a site that happens to have an
 * unrelated api.php file, or a soft-404 that returns 200 with something
 * that isn't valid siteinfo JSON at all).
 */
export async function detectMediaWiki(url, httpClient, options = {}) {
    let origin;
    try {
        origin = new URL(url).origin;
    }
    catch {
        return null;
    }
    const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
    for (const path of API_PATH_CANDIDATES) {
        const apiUrl = `${origin}${path}`;
        const body = await fetchJson(`${apiUrl}?action=query&meta=siteinfo&format=json`, httpClient, timeoutMs, userAgent);
        const general = body?.query?.general;
        if (general?.generator?.startsWith("MediaWiki")) {
            return { apiUrl, siteName: general.sitename ?? "", generator: general.generator };
        }
    }
    return null;
}
/**
 * Queries a specific page's rendered content HTML via action=parse. Returns
 * null on any API-level error (missing page, malformed response) rather
 * than throwing -- callers fall through to the normal fetch path on a miss.
 */
export async function queryMediaWikiPage(apiUrl, pageTitle, httpClient, options = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
    const queryUrl = `${apiUrl}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&redirects=1`;
    const body = await fetchJson(queryUrl, httpClient, timeoutMs, userAgent);
    if (!body || body.error)
        return null;
    const html = body.parse?.text?.["*"];
    if (!html?.trim())
        return null;
    return { title: body.parse?.title ?? pageTitle, html };
}
/** Minimal HTML-text escape for wrapping a MediaWiki API title in a synthetic <title> tag. */
function escapeHtmlText(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * ContentSourceStrategy adapter around {@link detectMediaWiki} +
 * {@link queryMediaWikiPage} — the extension-point-shaped form of the same
 * logic `spider()`'s legacy `preferMediaWiki` flag uses internally. Wraps
 * the API's article HTML in a minimal synthetic document so it runs through
 * the normal HTML extractor (Readability + metadata) exactly like a real
 * fetch would.
 */
export function mediaWikiContentSource(options = {}) {
    return {
        name: "mediawiki",
        matches(url) {
            return extractWikiPageTitle(url) !== null;
        },
        async fetch(req) {
            const pageTitle = extractWikiPageTitle(req.url);
            if (!pageTitle)
                return null;
            const probeOptions = { ...options, timeoutMs: req.timeoutMs, userAgent: req.userAgent };
            const siteInfo = await detectMediaWiki(req.url, req.httpClient, probeOptions);
            if (!siteInfo)
                return null;
            const page = await queryMediaWikiPage(siteInfo.apiUrl, pageTitle, req.httpClient, probeOptions);
            if (!page)
                return null;
            return {
                url: req.url,
                contentType: "text/html; charset=utf-8",
                text: `<html><head><title>${escapeHtmlText(page.title)}</title></head><body>${page.html}</body></html>`,
            };
        },
    };
}
//# sourceMappingURL=mediawiki.js.map