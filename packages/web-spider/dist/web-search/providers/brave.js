import { RATE_LIMIT_HEADER_PATTERN, withSiteFilter } from "../shared.js";
/** Maps the canonical timeRange string to Brave's freshness parameter. Reused by the Brave LLM Context adapter, which shares the same freshness vocabulary. */
export const BRAVE_FRESHNESS = {
    day: "pd",
    week: "pw",
    month: "pm",
    year: "py",
};
/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export async function braveSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey)
        throw new Error("Brave Search API key required — set BRAVE_SEARCH_API_KEY or pass opts.apiKey");
    const params = new URLSearchParams({
        q: withSiteFilter(query, opts.siteFilter),
        count: String(Math.min(opts.numResults ?? 10, 20)),
    });
    if (opts.country)
        params.set("country", opts.country);
    if (opts.freshness)
        params.set("freshness", opts.freshness);
    if (opts.extraSnippets)
        params.set("extra_snippets", "true");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
        res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": apiKey,
            },
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
    const rateLimitHeaders = {};
    for (const [name, value] of res.headers.entries()) {
        if (RATE_LIMIT_HEADER_PATTERN.test(name))
            rateLimitHeaders[name] = value;
    }
    if (Object.keys(rateLimitHeaders).length > 0)
        opts.onUsage?.({ rateLimitHeaders });
    const data = (await res.json());
    return (data.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.description ?? "",
        ...(r.age ? { publishedAt: r.age } : {}),
        ...(r.extra_snippets && r.extra_snippets.length > 0 ? { highlights: r.extra_snippets } : {}),
    }));
}
/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine {
    constructor(apiKey, country, onUsage, extraSnippets = true) {
        this.apiKey = apiKey;
        this.country = country;
        this.onUsage = onUsage;
        this.extraSnippets = extraSnippets;
    }
    search(req) {
        const freshness = req.timeRange ? BRAVE_FRESHNESS[req.timeRange] : undefined;
        return braveSearch(req.query, {
            apiKey: this.apiKey,
            numResults: req.numResults,
            country: this.country,
            freshness,
            siteFilter: req.siteFilter,
            onUsage: this.onUsage,
            extraSnippets: this.extraSnippets,
        });
    }
}
//# sourceMappingURL=brave.js.map