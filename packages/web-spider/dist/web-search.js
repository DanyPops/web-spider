/**
 * Web search API integration — Brave Search and Tavily.
 *
 * Both return a normalised WebSearchResult[].
 * API keys are read from environment variables by default:
 *   BRAVE_SEARCH_API_KEY
 *   TAVILY_API_KEY
 */
/** Header names worth capturing when present -- never a blanket capture of every response header. */
const RATE_LIMIT_HEADER_PATTERN = /rate.?limit|remaining|quota/i;
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
    if (data.costDollars?.total !== undefined)
        opts.onUsage?.({ costUsd: data.costDollars.total });
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
    if (opts.freshness)
        params.set("freshness", opts.freshness);
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
                // Free (no extra cost, per Tavily's own docs) -- just adds a `usage`
                // field to the response reporting this one call's own credit cost.
                include_usage: true,
                ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
                ...(opts.topic ? { topic: opts.topic } : {}),
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
    }));
}
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
    const apiKey = opts.apiKey ?? process.env["SERPER_API_KEY"];
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
            body: JSON.stringify({ q: query, num: opts.numResults ?? 10 }),
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
/**
 * Search the web via SerpApi (scraped, real Google SERPs -- not a curated
 * index). https://serpapi.com/search-api
 *
 * Request/response shape verified directly against SerpApi's own docs:
 * GET /search.json with engine/q/api_key/num params, organic_results[] in
 * the response. SerpApi can also return HTTP 200 with a top-level `error`
 * field for some failures (documented behavior, e.g. an exhausted plan) --
 * checked explicitly, not just res.ok.
 */
export async function serpApiSearch(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env["SERPAPI_API_KEY"];
    if (!apiKey)
        throw new Error("SerpApi key required — set SERPAPI_API_KEY or pass opts.apiKey");
    const params = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: apiKey,
        num: String(opts.numResults ?? 10),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
        res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
    if (!res.ok)
        throw new Error(`SerpApi error: ${res.status} ${res.statusText}`);
    const data = (await res.json());
    if (data.error)
        throw new Error(`SerpApi error: ${data.error}`);
    return (data.organic_results ?? []).map((r) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet ?? "",
        ...(r.date ? { publishedAt: r.date } : {}),
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
    const engine = opts.engine
        ? resolveSearchEngine(opts.engine, process.env[envKeyForEngine(opts.engine)])
        : defaultSearchEngine();
    return engine.search({
        query,
        numResults: opts.numResults,
        timeRange: opts.timeRange,
        topic: opts.topic,
    });
}
/** The global engine registry. Seeded with built-in engines below. */
const ENGINE_REGISTRY = new Map();
/**
 * Register a search engine under a name.
 *
 * Call this to add a new engine without touching any existing code:
 * @example
 * registerSearchEngine("my-engine", (key) => new MyEngine(key!))
 */
export function registerSearchEngine(name, factory) {
    ENGINE_REGISTRY.set(name, factory);
}
/**
 * Resolve a registered engine by name, passing the provided API key.
 * Throws a descriptive error for unknown names or missing required keys.
 */
export function resolveSearchEngine(name, key) {
    const factory = ENGINE_REGISTRY.get(name);
    if (!factory)
        throw new Error(`Unknown search engine: "${name}". Register it with registerSearchEngine().`);
    return factory(key);
}
/** @internal Map engine name to its env var key name (for webSearch auto-detect). */
function envKeyForEngine(name) {
    const envKeys = {
        brave: "BRAVE_SEARCH_API_KEY",
        tavily: "TAVILY_API_KEY",
        exa: "EXA_API_KEY",
        serper: "SERPER_API_KEY",
        serpapi: "SERPAPI_API_KEY",
    };
    return envKeys[name] ?? "";
}
// Seed the registry with built-in engines.
// Adding a new engine: call registerSearchEngine() — do NOT edit this block.
registerSearchEngine("brave", (key) => {
    if (!key)
        throw new Error("BRAVE_SEARCH_API_KEY not set");
    return new BraveSearchEngine(key);
});
registerSearchEngine("tavily", (key) => {
    if (!key)
        throw new Error("TAVILY_API_KEY not set");
    return new TavilySearchEngine(key);
});
registerSearchEngine("exa", (key) => {
    if (!key)
        throw new Error("EXA_API_KEY not set");
    return new ExaSearchEngine(key);
});
registerSearchEngine("serper", (key) => {
    if (!key)
        throw new Error("SERPER_API_KEY not set");
    return new SerperSearchEngine(key);
});
registerSearchEngine("serpapi", (key) => {
    if (!key)
        throw new Error("SERPAPI_API_KEY not set");
    return new SerpApiSearchEngine(key);
});
registerSearchEngine("ddg", () => new DdgSearchEngine());
// ---------------------------------------------------------------------------
// ISearchEngine adapters — concrete implementations of the port
// ---------------------------------------------------------------------------
/** Maps the canonical timeRange string to Brave's freshness parameter. */
const BRAVE_FRESHNESS = {
    day: "pd",
    week: "pw",
    month: "pm",
    year: "py",
};
/** Brave Search adapter implementing ISearchEngine. */
export class BraveSearchEngine {
    constructor(apiKey, country, onUsage) {
        this.apiKey = apiKey;
        this.country = country;
        this.onUsage = onUsage;
    }
    search(req) {
        const freshness = req.timeRange ? BRAVE_FRESHNESS[req.timeRange] : undefined;
        return braveSearch(req.query, {
            apiKey: this.apiKey,
            numResults: req.numResults,
            country: this.country,
            freshness,
            onUsage: this.onUsage,
        });
    }
}
/** Tavily adapter implementing ISearchEngine. */
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
            onUsage: this.onUsage,
        });
    }
}
/** Exa adapter implementing ISearchEngine. */
export class ExaSearchEngine {
    constructor(apiKey, onUsage) {
        this.apiKey = apiKey;
        this.onUsage = onUsage;
    }
    search(req) {
        return exaSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults, onUsage: this.onUsage });
    }
}
/** Serper.dev adapter implementing ISearchEngine. */
export class SerperSearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return serperSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
    }
}
/** SerpApi adapter implementing ISearchEngine. */
export class SerpApiSearchEngine {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    search(req) {
        return serpApiSearch(req.query, { apiKey: this.apiKey, numResults: req.numResults });
    }
}
/** DuckDuckGo Instant Answer adapter — no API key required. */
export class DdgSearchEngine {
    search(req) {
        return ddgSearch(req.query, { numResults: req.numResults });
    }
}
// ---------------------------------------------------------------------------
// FallbackSearchEngine — strategy composite
// ---------------------------------------------------------------------------
/** True for a short-lived throttling response worth a brief cooldown: standard 429 and "too many requests"/"rate limit" phrasing. Distinct from {@link isLikelyQuotaExceededError} -- a request-rate throttle clears in seconds to minutes, an exhausted account quota does not. */
export function isLikelyRateLimitError(error) {
    if (!(error instanceof Error))
        return false;
    if (/\b429\b/.test(error.message))
        return true;
    return /rate.?limit|too many requests/i.test(error.message);
}
/** True for an account-level quota/plan exhaustion worth a much longer disable than a rate limit: Tavily's non-standard 432, 402 Payment Required, and phrasing like "quota exceeded", "usage limit", "out of searches/credits", "plan limit". Retrying before the billing/quota window resets just wastes a call and re-triggers the same failure. */
export function isLikelyQuotaExceededError(error) {
    if (!(error instanceof Error))
        return false;
    if (/\b(432|402)\b/.test(error.message))
        return true;
    return /quota|usage limit|out of (searches|credits)|plan limit|insufficient credits|run out of/i.test(error.message);
}
/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws, and
 * skipping an engine for a cooldown window after a rate-limit-shaped
 * failure rather than retrying an already-exhausted quota on every call.
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
        this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
        this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
        this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
        this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
        this.now = opts.now ?? Date.now;
        this.onEngineFailure = opts.onEngineFailure;
        this.cooldownUntil = engines.map(() => 0);
    }
    async search(req) {
        let lastError;
        // Gates the final throw below: a later engine completing with zero hits
        // is a real empty result, never masked by an earlier engine's error.
        let anySucceeded = false;
        for (let i = 0; i < this.engines.length; i++) {
            if (this.cooldownUntil[i] > this.now()) {
                const cooldownError = new Error(`engine ${i} skipped: in cooldown after a recent rate-limit/quota error`);
                lastError = cooldownError;
                this.onEngineFailure?.(i, cooldownError, "cooldown");
                continue;
            }
            try {
                const results = await this.engines[i].search(req);
                anySucceeded = true;
                if (results.length > 0 || !this.fallbackOnEmpty)
                    return results;
                // Empty + fallbackOnEmpty → try next engine
            }
            catch (err) {
                if (!this.fallbackOnError)
                    throw err;
                lastError = err;
                if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
                    this.cooldownUntil[i] = this.now() + this.quotaCooldownMs;
                    this.onEngineFailure?.(i, err, "quota");
                }
                else {
                    if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
                        this.cooldownUntil[i] = this.now() + this.cooldownMs;
                    }
                    this.onEngineFailure?.(i, err, "error");
                }
                // Error + fallbackOnError → try next engine
            }
        }
        if (!anySucceeded && lastError)
            throw lastError;
        return [];
    }
}
/**
 * A composite ISearchEngine that spreads calls evenly across equal-tier
 * engines instead of always hitting the first one -- unlike
 * FallbackSearchEngine's fixed priority order (best engine first, worse
 * ones as fallback), round-robin treats every engine as an interchangeable
 * peer and cycles through them one call at a time.
 *
 * Tracks cooldown per engine (not per composite), so nesting this inside a
 * FallbackSearchEngine never lets one member's rate limit collapse the
 * whole group's fate -- the entire reason to round-robin quota-limited
 * peers is to keep their quotas independent. A cooling-down slot is
 * skipped in favor of the next available one; if every engine is cooling
 * down, the call throws (letting an outer FallbackSearchEngine fall
 * through to its next entry, e.g. DDG).
 *
 * Still does no fallback on a genuine call failure -- the picked engine's
 * error propagates as-is rather than trying a sibling within the same
 * call. That stays the outer FallbackSearchEngine's job.
 *
 * @example
 * // Spread load across three paid engines, DDG as the zero-cost last resort
 * const engine = new FallbackSearchEngine([
 *   new RoundRobinSearchEngine([tavily, serper, serpapi]),
 *   new DdgSearchEngine(),
 * ]);
 */
export class RoundRobinSearchEngine {
    constructor(engines, opts = {}) {
        this.engines = engines;
        this.cursor = 0;
        if (engines.length === 0)
            throw new Error("RoundRobinSearchEngine requires at least one engine");
        this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
        this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
        this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
        this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
        this.now = opts.now ?? Date.now;
        this.onEngineFailure = opts.onEngineFailure;
        this.cooldownUntil = engines.map(() => 0);
    }
    async search(req) {
        const start = this.cursor;
        this.cursor = (start + 1) % this.engines.length;
        let index = -1;
        for (let attempt = 0; attempt < this.engines.length; attempt++) {
            const candidate = (start + attempt) % this.engines.length;
            if (this.cooldownUntil[candidate] > this.now()) {
                const cooldownError = new Error(`engine ${candidate} skipped: in cooldown after a recent rate-limit/quota error`);
                this.onEngineFailure?.(candidate, cooldownError, "cooldown");
                continue;
            }
            index = candidate;
            break;
        }
        if (index === -1)
            throw new Error("RoundRobinSearchEngine: every engine is currently in cooldown");
        try {
            return await this.engines[index].search(req);
        }
        catch (err) {
            if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
                this.cooldownUntil[index] = this.now() + this.quotaCooldownMs;
                this.onEngineFailure?.(index, err, "quota");
            }
            else {
                if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
                    this.cooldownUntil[index] = this.now() + this.cooldownMs;
                }
                this.onEngineFailure?.(index, err, "error");
            }
            throw err;
        }
    }
}
export function defaultSearchEngine(opts = {}) {
    const env = opts.env ?? process.env;
    const rotationEngines = [];
    const rotationNames = [];
    const brave = env["BRAVE_SEARCH_API_KEY"];
    if (brave) {
        rotationEngines.push(new BraveSearchEngine(brave, undefined, opts.onUsage ? (usage) => opts.onUsage?.("brave", usage) : undefined));
        rotationNames.push("brave");
    }
    const tavily = env["TAVILY_API_KEY"];
    if (tavily) {
        rotationEngines.push(new TavilySearchEngine(tavily, opts.onUsage ? (usage) => opts.onUsage?.("tavily", usage) : undefined));
        rotationNames.push("tavily");
    }
    const exa = env["EXA_API_KEY"];
    if (exa) {
        rotationEngines.push(new ExaSearchEngine(exa, opts.onUsage ? (usage) => opts.onUsage?.("exa", usage) : undefined));
        rotationNames.push("exa");
    }
    const serper = env["SERPER_API_KEY"];
    if (serper) {
        rotationEngines.push(new SerperSearchEngine(serper));
        rotationNames.push("serper");
    }
    const serpapi = env["SERPAPI_API_KEY"];
    if (serpapi) {
        rotationEngines.push(new SerpApiSearchEngine(serpapi));
        rotationNames.push("serpapi");
    }
    const engines = [];
    const outerNames = [];
    if (rotationEngines.length === 1) {
        engines.push(rotationEngines[0]);
        outerNames.push(rotationNames[0]);
    }
    else if (rotationEngines.length > 1) {
        engines.push(new RoundRobinSearchEngine(rotationEngines, {
            cooldownMs: opts.cooldownMs,
            quotaCooldownMs: opts.quotaCooldownMs,
            onEngineFailure: opts.onEngineFailure ? (index, error, reason) => opts.onEngineFailure?.(rotationNames[index] ?? `engine-${index}`, error, reason) : undefined,
        }));
        outerNames.push("rotation-group");
    }
    // DDG always last — no key needed, never throws the "no key" error
    engines.push(new DdgSearchEngine());
    outerNames.push("ddg");
    // The round-robin group already tracks cooldown (both tiers) per real
    // engine inside itself. If the outer chain also cooled down the *group's
    // own slot* whenever one member's failure bubbles up through it, a single
    // exhausted peer would collapse the whole group's fate one layer up --
    // exactly the bug round-robin exists to avoid. Disable both outer-layer
    // cooldown tiers whenever there's a group to protect; the single-keyed-
    // engine case (no group) keeps its own outer cooldowns exactly as before.
    const outerCooldownMs = rotationEngines.length > 1 ? 0 : opts.cooldownMs;
    const outerQuotaCooldownMs = rotationEngines.length > 1 ? 0 : opts.quotaCooldownMs;
    return new FallbackSearchEngine(engines, {
        cooldownMs: outerCooldownMs,
        quotaCooldownMs: outerQuotaCooldownMs,
        onEngineFailure: opts.onEngineFailure ? (index, error, reason) => opts.onEngineFailure?.(outerNames[index] ?? `engine-${index}`, error, reason) : undefined,
    });
}
//# sourceMappingURL=web-search.js.map