const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;
function timeRangeParameter(timeRange) {
    const values = {
        day: "qdr:d",
        week: "qdr:w",
        month: "qdr:m",
        year: "qdr:y",
    };
    return timeRange ? values[timeRange] : undefined;
}
function normalizeResult(result) {
    if (typeof result.url !== "string" || typeof result.title !== "string")
        return undefined;
    let url;
    try {
        url = new URL(result.url);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return undefined;
    const title = result.title.trim();
    if (!title)
        return undefined;
    const rawSnippet = typeof result.description === "string" ? result.description : typeof result.snippet === "string" ? result.snippet : "";
    const publishedAt = typeof result.date === "string" ? result.date.trim() : "";
    return {
        url: url.toString(),
        title,
        snippet: rawSnippet.trim(),
        ...(publishedAt ? { publishedAt } : {}),
    };
}
function boundedResultCount(value) {
    if (!Number.isFinite(value))
        return MAX_RESULTS;
    return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value)));
}
function retrySuffix(response) {
    const retryAfter = response.headers.get("retry-after")?.trim();
    return retryAfter && /^\d{1,6}$/.test(retryAfter) ? ` — retry after ${retryAfter}s` : "";
}
/** Search Firecrawl's officially supported per-IP keyless fallback endpoint. */
export async function firecrawlKeylessSearch(query, options = {}) {
    const transport = options.transport ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const source = options.topic === "news" ? "news" : "web";
    // Firecrawl documents tbs for web results only; it does not filter news.
    const tbs = source === "web" ? timeRangeParameter(options.timeRange) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await transport(FIRECRAWL_SEARCH_ENDPOINT, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                limit: boundedResultCount(options.numResults),
                sources: [source],
                highlights: false,
                ...(tbs ? { tbs } : {}),
                ...(options.siteFilter ? { includeDomains: [options.siteFilter] } : {}),
            }),
        });
    }
    catch (error) {
        if (controller.signal.aborted)
            throw new Error(`Firecrawl keyless search timed out after ${timeoutMs}ms`, { cause: error });
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`Firecrawl keyless search error: ${response.status} ${response.statusText}${retrySuffix(response)}`);
    }
    let payload;
    try {
        payload = await response.json();
    }
    catch (error) {
        throw new Error("Firecrawl keyless search returned malformed JSON", { cause: error });
    }
    if (!payload || typeof payload !== "object" || payload.success !== true) {
        throw new Error("Firecrawl keyless search returned an unsuccessful payload");
    }
    const data = payload.data;
    if (!data || typeof data !== "object")
        throw new Error("Firecrawl keyless search returned a malformed payload");
    const results = data[source];
    if (!Array.isArray(results))
        throw new Error("Firecrawl keyless search returned a malformed payload");
    return results
        .map((result) => normalizeResult(result))
        .filter((result) => result !== undefined);
}
/** Keyless Firecrawl adapter implementing the existing search Strategy port. */
export class FirecrawlKeylessSearchEngine {
    constructor(options = {}) {
        this.options = options;
    }
    search(request) {
        return firecrawlKeylessSearch(request.query, {
            ...this.options,
            numResults: request.numResults,
            timeRange: request.timeRange,
            topic: request.topic,
            siteFilter: request.siteFilter,
        });
    }
}
//# sourceMappingURL=firecrawl-keyless.js.map