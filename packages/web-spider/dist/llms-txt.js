const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
/**
 * Probes a target URL's origin for a real llms.txt. Returns null (never
 * throws for a missing/broken llms.txt) so callers can cheaply fall back to
 * their normal fetch path.
 *
 * Guards against a real false-positive risk: many SPAs return 200 text/html
 * (their app shell) for any unmatched path rather than a real 404 -- a
 * genuine llms.txt is always text-based, so an HTML content-type is treated
 * as "not found," not a hit.
 */
export async function probeLlmsTxt(targetUrl, httpClient, options = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT, includeFullVariant = false } = options;
    let origin;
    try {
        origin = new URL(targetUrl).origin;
    }
    catch {
        return null;
    }
    const candidates = [{ url: `${origin}/llms.txt`, variant: "llms.txt" }];
    if (includeFullVariant)
        candidates.push({ url: `${origin}/llms-full.txt`, variant: "llms-full.txt" });
    for (const candidate of candidates) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await httpClient.fetch({
                url: candidate.url,
                signal: controller.signal,
                headers: { "User-Agent": userAgent, Accept: "text/plain, text/markdown, */*" },
            });
            if (!res.ok)
                continue;
            const contentType = res.headers.get("content-type");
            if (contentType?.toLowerCase().includes("html"))
                continue; // SPA soft-404, not a real llms.txt
            const content = await res.text();
            if (!content.trim())
                continue;
            return { url: candidate.url, variant: candidate.variant, content, contentType };
        }
        catch {
            // try the next candidate
        }
        finally {
            clearTimeout(timer);
        }
    }
    return null;
}
//# sourceMappingURL=llms-txt.js.map