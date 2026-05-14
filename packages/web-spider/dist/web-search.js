/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
/**
 * Search the web via the Brave Search API.
 * https://api.search.brave.com/app/documentation/web-search
 */
export async function braveSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env["BRAVE_SEARCH_API_KEY"];
    if (!apiKey)
        throw new Error("Brave Search API key required — set BRAVE_SEARCH_API_KEY or pass opts.apiKey");
    const params = new URLSearchParams({
        q: query,
        count: String(Math.min(opts.numResults ?? 10, 20)),
    });
    if (opts.country)
        params.set("country", opts.country);
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
    const data = (await res.json());
    return (data.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.description ?? "",
        ...(r.age ? { publishedAt: r.age } : {}),
    }));
}
/**
 * Search the web via the Tavily API.
 * https://docs.tavily.com/docs/rest-api/api-reference
 */
export async function tavilySearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env["TAVILY_API_KEY"];
    if (!apiKey)
        throw new Error("Tavily API key required — set TAVILY_API_KEY or pass opts.apiKey");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
        res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                api_key: apiKey,
                max_results: opts.numResults ?? 5,
                search_depth: opts.depth ?? "basic",
                include_raw_content: false,
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content ?? "",
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
    }));
}
/**
 * Search using whichever engine has an API key available.
 * Tries Brave first, then Tavily, throws if neither is configured.
 */
export async function webSearch(query, opts = {}) {
    const engine = opts.engine ??
        (process.env["BRAVE_SEARCH_API_KEY"] ? "brave" : process.env["TAVILY_API_KEY"] ? "tavily" : null);
    if (!engine) {
        throw new Error("No search API key found. Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY.");
    }
    return engine === "brave"
        ? braveSearch(query, { numResults: opts.numResults })
        : tavilySearch(query, { numResults: opts.numResults });
}
//# sourceMappingURL=web-search.js.map