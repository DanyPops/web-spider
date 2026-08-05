import { withSiteFilter } from "../shared.js";
/**
 * Search the web via Serper.dev (Google-backed SERP API).
 * https://serper.dev/
 *
 * Response shape (organic[]/knowledgeGraph) verified directly against
 * serper.dev's own homepage sample response. Request contract (POST,
 * X-API-KEY header, {q} body) is long-standing, widely-documented public
 * convention -- not independently re-confirmed against a formal docs page
 * this session (their playground page is JS-rendered/cookie-walled).
 */
export async function serperSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.SERPER_API_KEY;
    if (!apiKey)
        throw new Error("Serper API key required — set SERPER_API_KEY or pass opts.apiKey");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
        res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            signal: controller.signal,
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: withSiteFilter(query, opts.siteFilter), num: opts.numResults ?? 10 }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Serper API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    return (data.organic ?? []).map((r) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet ?? "",
        ...(r.date ? { publishedAt: r.date } : {}),
    }));
}
/** Serper.dev adapter implementing ISearchEngine. */
export class SerperSearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return serperSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
    }
}
//# sourceMappingURL=serper.js.map