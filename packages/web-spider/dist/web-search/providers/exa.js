/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export async function exaSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.EXA_API_KEY;
    if (!apiKey)
        throw new Error("Exa API key required — set EXA_API_KEY or pass opts.apiKey");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
        res = await fetch("https://api.exa.ai/search", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
            body: JSON.stringify({
                query,
                numResults: opts.numResults ?? 10,
                type: opts.type ?? "auto",
                contents: {
                    highlights: { numSentences: 2, highlightsPerUrl: 3 },
                    ...(opts.includeText ? { text: true } : {}),
                },
                ...(opts.siteFilter ? { includeDomains: [opts.siteFilter] } : {}),
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Exa API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    if (data.costDollars?.total !== undefined)
        opts.onUsage?.({ costUsd: data.costDollars.total });
    return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.highlights?.join(" … ") ?? "",
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
        ...(r.highlights && r.highlights.length > 0 ? { highlights: r.highlights } : {}),
        ...(r.text ? { content: r.text } : {}),
    }));
}
/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine {
    constructor(apiKey, onUsage) {
        this.apiKey = apiKey;
        this.onUsage = onUsage;
    }
    search(req) {
        return exaSearch(req.query, {
            apiKey: this.apiKey,
            numResults: req.numResults,
            siteFilter: req.siteFilter,
            onUsage: this.onUsage,
            includeText: req.wantFullContent,
        });
    }
}
//# sourceMappingURL=exa.js.map