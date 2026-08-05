/**
 * Search the web via the You.com Search API (independent index, AI-first
 * response format). https://you.com/docs/guides/search
 *
 * Each web result can carry multiple pre-ranked `snippets` -- richer than
 * the single-description shape most other engines return, surfaced via
 * {@link WebSearchResult.highlights}.
 */
export async function youComSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.YOU_API_KEY;
    if (!apiKey)
        throw new Error("You.com API key required — set YOU_API_KEY or pass opts.apiKey");
    const params = new URLSearchParams({
        query,
        count: String(opts.numResults ?? 10),
    });
    if (opts.siteFilter)
        params.set("include_domains", opts.siteFilter);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
        // api.ydc-index.io, not the bare ydc-index.io apex domain -- confirmed against
        // You.com's own docs/blog, its AWS Marketplace listing, and Databricks's
        // integration guide, all of which agree on the api. subdomain.
        res = await fetch(`https://api.ydc-index.io/v1/search?${params}`, {
            signal: controller.signal,
            headers: { "X-API-Key": apiKey, Accept: "application/json" },
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`You.com API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    return (data.results?.web ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.description ?? r.snippets?.[0] ?? "",
        ...(r.page_age ? { publishedAt: r.page_age } : {}),
        ...(r.snippets && r.snippets.length > 0 ? { highlights: r.snippets } : {}),
    }));
}
/** You.com adapter implementing ISearchEngine. */
export class YouComSearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return youComSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, siteFilter: req.siteFilter });
    }
}
//# sourceMappingURL=you.js.map