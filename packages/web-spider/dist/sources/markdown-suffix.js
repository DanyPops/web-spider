const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const HTML_EXTENSION = /\.html?$/i;
/**
 * Derives the .md sibling URL for a documentation-shaped page, or null when
 * no sensible variant applies (already .md, or has some other extension
 * this convention doesn't cover, e.g. .pdf/.json).
 */
export function deriveMarkdownVariantUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (parsed.pathname.toLowerCase().endsWith(".md"))
        return null; // already markdown
    if (HTML_EXTENSION.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(HTML_EXTENSION, ".md");
        return parsed.toString();
    }
    const hasOtherExtension = /\.[a-z0-9]+$/i.test(parsed.pathname);
    if (hasOtherExtension)
        return null; // .pdf, .json, etc. -- not this convention's shape
    // Extensionless path (with or without a trailing slash) -- append .md.
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}.md`;
    return parsed.toString();
}
/**
 * Probes the .md variant of a specific URL. Returns null (never throws) for
 * anything that isn't a clean text-based 200 -- including the case where
 * deriveMarkdownVariantUrl finds no sensible variant to try at all.
 */
export async function probeMarkdownVariant(url, httpClient, options = {}) {
    const variantUrl = deriveMarkdownVariantUrl(url);
    if (!variantUrl)
        return null;
    const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await httpClient.fetch({
            url: variantUrl,
            signal: controller.signal,
            headers: { "User-Agent": userAgent, Accept: "text/markdown, text/plain, */*" },
        });
        if (!res.ok)
            return null;
        const contentType = res.headers.get("content-type");
        if (contentType?.toLowerCase().includes("html"))
            return null; // SPA soft-404 or redirected back to HTML
        const content = await res.text();
        if (!content.trim())
            return null;
        return { url: variantUrl, content, contentType };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=markdown-suffix.js.map