/**
 * Search the web via the Tavily API.
 * https://docs.tavily.com/docs/rest-api/api-reference
 */
export async function tavilySearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey)
        throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
        res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                query,
                max_results: opts.numResults ?? 5,
                search_depth: opts.depth ?? "basic",
                include_raw_content: opts.includeRawContent ?? false,
                // Free (no extra cost, per Tavily's own docs) -- just adds a `usage`
                // field to the response reporting this one call's own credit cost.
                include_usage: true,
                ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
                ...(opts.topic ? { topic: opts.topic } : {}),
                ...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
                ...(opts.excludeDomains && opts.excludeDomains.length > 0 ? { exclude_domains: opts.excludeDomains } : {}),
                ...(opts.includeFavicon ? { include_favicon: opts.includeFavicon } : {}),
                ...(opts.country ? { country: opts.country } : {}),
                ...(opts.startDate ? { start_date: opts.startDate } : {}),
                ...(opts.endDate ? { end_date: opts.endDate } : {}),
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    if (data.usage?.credits !== undefined)
        opts.onUsage?.({ credits: data.usage.credits });
    return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content ?? "",
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
        ...(r.raw_content ? { content: r.raw_content } : {}),
    }));
}
/**
 * Search via Tavily with `include_answer` enabled -- returns a synthesized,
 * LLM-generated answer plus the sources it was built from, instead of a
 * plain results list. Reference implementation of the answer-first port
 * ({@link IAnswerSearchEngine}): reuses Tavily's existing search endpoint
 * and API key rather than requiring a new vendor.
 */
export async function tavilySearchForAnswer(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
    if (!apiKey)
        throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
        res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                query,
                max_results: opts.numResults ?? 5,
                search_depth: opts.depth ?? "basic",
                include_answer: opts.answerDepth ?? true,
                include_usage: true,
                ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
                ...(opts.topic ? { topic: opts.topic } : {}),
                ...(opts.siteFilter ? { include_domains: [opts.siteFilter] } : {}),
                ...(opts.excludeDomains && opts.excludeDomains.length > 0 ? { exclude_domains: opts.excludeDomains } : {}),
                ...(opts.includeFavicon ? { include_favicon: opts.includeFavicon } : {}),
                ...(opts.country ? { country: opts.country } : {}),
                ...(opts.startDate ? { start_date: opts.startDate } : {}),
                ...(opts.endDate ? { end_date: opts.endDate } : {}),
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    if (data.usage?.credits !== undefined)
        opts.onUsage?.({ credits: data.usage.credits });
    return {
        answer: data.answer ?? "",
        sources: (data.results ?? []).map((r) => ({
            url: r.url,
            title: r.title,
            snippet: r.content ?? "",
            ...(r.published_date ? { publishedAt: r.published_date } : {}),
        })),
    };
}
/** Tavily adapter implementing ISearchEngine and IAnswerSearchEngine (reference implementation of the answer-first port, via Tavily's own include_answer). */
export class TavilySearchEngine {
    constructor(apiKey, onUsage) {
        this.apiKey = apiKey;
        this.onUsage = onUsage;
    }
    search(req) {
        return tavilySearch(req.query, {
            apiKey: this.apiKey,
            numResults: req.numResults,
            timeRange: req.timeRange,
            topic: req.topic,
            siteFilter: req.siteFilter,
            includeRawContent: req.wantFullContent,
            onUsage: this.onUsage,
        });
    }
    searchForAnswer(req) {
        return tavilySearchForAnswer(req.query, {
            apiKey: this.apiKey,
            numResults: req.numResults,
            timeRange: req.timeRange,
            topic: req.topic,
            siteFilter: req.siteFilter,
            onUsage: this.onUsage,
        });
    }
}
//# sourceMappingURL=tavily.js.map