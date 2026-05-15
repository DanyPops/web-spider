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
 * Search via the DuckDuckGo Instant Answer API.
 * https://duckduckgo.com/api
 *
 * No API key required. Returns structured instant answers (Abstract,
 * Results, RelatedTopics) mapped to WebSearchResult[].
 *
 * Limitation: not a full web index — best for well-known entities and
 * unambiguous queries. Returns empty when DDG has no instant answer.
 */
export async function ddgSearch(query, opts = {}) {
    const params = new URLSearchParams({
        q: query,
        format: "json",
        no_redirect: "1",
        no_html: "1",
        skip_disambig: "1",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res;
    try {
        res = await fetch(`https://api.duckduckgo.com/?${params}`, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                // DDG silently returns an empty 200 body for browser-like or
                // missing User-Agents. A curl/bot-style UA gets a real 202.
                "User-Agent": "web-spider/0.8",
            },
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`DDG API error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    const results = [];
    const limit = opts.numResults ?? 10;
    // 1. Instant answer abstract (Wikipedia-style knowledge panel)
    if (data.Abstract && data.AbstractURL) {
        results.push({
            url: data.AbstractURL,
            title: data.Heading ?? data.AbstractSource ?? "DuckDuckGo",
            snippet: data.Abstract,
        });
    }
    // 2. Official results (e.g. official site links)
    for (const r of data.Results ?? []) {
        if (results.length >= limit)
            break;
        if (r.FirstURL)
            results.push({ url: r.FirstURL, title: r.Text, snippet: r.Text });
    }
    // 3. Related topics — flatten one level of nesting
    for (const topic of data.RelatedTopics ?? []) {
        if (results.length >= limit)
            break;
        if (topic.FirstURL && topic.Text) {
            results.push({ url: topic.FirstURL, title: topic.Text, snippet: topic.Text });
        }
        for (const sub of topic.Topics ?? []) {
            if (results.length >= limit)
                break;
            results.push({ url: sub.FirstURL, title: sub.Text, snippet: sub.Text });
        }
    }
    return results;
}
/**
 * Search using whichever engine is explicitly requested or has an API key
 * available. Falls through to the DDG Instant Answer API as a zero-cost
 * last resort — no key required.
 *
 * Prefer {@link defaultSearchEngine} + {@link FallbackSearchEngine} when
 * you need composable retry / fallback behaviour.
 */
export async function webSearch(query, opts = {}) {
    const engine = resolveEngine(opts.engine, opts.numResults);
    return engine.search({ query, numResults: opts.numResults });
}
/** @internal Resolve a named engine (or auto-detect) into an ISearchEngine instance. */
function resolveEngine(name, numResults) {
    void numResults; // forwarded per-call, not stored on the engine
    switch (name) {
        case "brave": {
            const key = process.env["BRAVE_SEARCH_API_KEY"];
            if (!key)
                throw new Error("BRAVE_SEARCH_API_KEY not set");
            return new BraveSearchEngine(key);
        }
        case "tavily": {
            const key = process.env["TAVILY_API_KEY"];
            if (!key)
                throw new Error("TAVILY_API_KEY not set");
            return new TavilySearchEngine(key);
        }
        case "exa": {
            const key = process.env["EXA_API_KEY"];
            if (!key)
                throw new Error("EXA_API_KEY not set");
            return new ExaSearchEngine(key);
        }
        case "ddg":
            return new DdgSearchEngine();
        default:
            return defaultSearchEngine();
    }
}
// ---------------------------------------------------------------------------
// ISearchEngine adapters — concrete implementations of the port
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
/** DuckDuckGo Instant Answer adapter — no API key required. */
export class DdgSearchEngine {
    search(req) {
        return ddgSearch(req.query, { numResults: req.numResults });
    }
}
/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws.
 *
 * Because it implements ISearchEngine itself it is fully composable —
 * nest FallbackSearchEngines, wrap them in caches, inject stubs in tests.
 *
 * @example
 * // Tavily with DDG as zero-cost fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new DdgSearchEngine(),
 * ]);
 */
export class FallbackSearchEngine {
    constructor(engines, opts = {}) {
        this.engines = engines;
        if (engines.length === 0)
            throw new Error("FallbackSearchEngine requires at least one engine");
        this.fallbackOnEmpty = opts.fallbackOnEmpty ?? true;
        this.fallbackOnError = opts.fallbackOnError ?? true;
    }
    async search(req) {
        let lastError;
        for (const engine of this.engines) {
            try {
                const results = await engine.search(req);
                if (results.length > 0 || !this.fallbackOnEmpty)
                    return results;
                // Empty + fallbackOnEmpty → try next engine
            }
            catch (err) {
                if (!this.fallbackOnError)
                    throw err;
                lastError = err;
                // Error + fallbackOnError → try next engine
            }
        }
        // All engines exhausted — surface the last error or return empty
        if (lastError)
            throw lastError;
        return [];
    }
}
// ---------------------------------------------------------------------------
// Wiring — compose engines from environment variables
// ---------------------------------------------------------------------------
/**
 * Build a FallbackSearchEngine chain from environment variables.
 *
 * Priority order for keyed engines: Brave → Tavily → Exa.
 * DuckDuckGo is always appended as the zero-cost last resort.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export function defaultSearchEngine() {
    const engines = [];
    const brave = process.env["BRAVE_SEARCH_API_KEY"];
    if (brave)
        engines.push(new BraveSearchEngine(brave));
    const tavily = process.env["TAVILY_API_KEY"];
    if (tavily)
        engines.push(new TavilySearchEngine(tavily));
    const exa = process.env["EXA_API_KEY"];
    if (exa)
        engines.push(new ExaSearchEngine(exa));
    // DDG always last — no key needed, never throws the "no key" error
    engines.push(new DdgSearchEngine());
    return new FallbackSearchEngine(engines);
}
//# sourceMappingURL=web-search.js.map