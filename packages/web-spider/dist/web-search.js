/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
/**
 * Search the web via the Exa Search API (neural/semantic retrieval).
 * https://exa.ai/docs/reference/search
 *
 * Returns highlights inline per result — richer snippets without extra round-trips.
 */
export async function exaSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env["EXA_API_KEY"];
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
                },
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`Exa API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.highlights?.join(" … ") ?? "",
        ...(r.publishedDate ? { publishedAt: r.publishedDate } : {}),
    }));
}
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
        (process.env["BRAVE_SEARCH_API_KEY"]
            ? "brave"
            : process.env["TAVILY_API_KEY"]
                ? "tavily"
                : process.env["EXA_API_KEY"]
                    ? "exa"
                    : null);
    if (!engine) {
        throw new Error("No search API key found. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or EXA_API_KEY.");
    }
    if (engine === "brave")
        return braveSearch(query, { numResults: opts.numResults });
    if (engine === "tavily")
        return tavilySearch(query, { numResults: opts.numResults });
    return exaSearch(query, { numResults: opts.numResults });
}
// ---------------------------------------------------------------------------
// ISearchEngine adapters
// ---------------------------------------------------------------------------
/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine {
    constructor(apiKey, country) {
        this.apiKey = apiKey;
        this.country = country;
    }
    search(req) {
        return braveSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, country: this.country });
    }
}
/** Tavily adapter implementing ISearchEngine. */
export class TavilySearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return tavilySearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
    }
}
/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return exaSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
    }
}
/**
 * Build an ISearchEngine from environment variables.
 * Priority: Brave → Tavily → Exa.
 */
export function defaultSearchEngine() {
    const brave = process.env["BRAVE_SEARCH_API_KEY"];
    if (brave)
        return new BraveSearchEngine(brave);
    const tavily = process.env["TAVILY_API_KEY"];
    if (tavily)
        return new TavilySearchEngine(tavily);
    const exa = process.env["EXA_API_KEY"];
    if (exa)
        return new ExaSearchEngine(exa);
    throw new Error("No search API key found. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or EXA_API_KEY.");
}
//# sourceMappingURL=web-search.js.map