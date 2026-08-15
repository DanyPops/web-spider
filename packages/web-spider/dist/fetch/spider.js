import { isLikelyFetchTransportFailure, ResponseTooLargeError, toFetchTransportError } from "../errors.js";
import { queryGitHub } from "../sources/github.js";
import { probeLlmsTxt } from "../sources/llms-txt.js";
import { probeMarkdownVariant } from "../sources/markdown-suffix.js";
import { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "../sources/mediawiki.js";
import { extractFetchedResource, } from "./content-extractor.js";
import { DefaultSsrfGuard } from "./ssrf-guard.js";
// ---------------------------------------------------------------------------
// Default HTTP client adapter
// ---------------------------------------------------------------------------
/** Default outbound response bound -- generous enough for real docs/PDFs, small enough to cap worst-case memory per fetch. */
export const DEFAULT_MAX_RESPONSE_BYTES = 25_000_000;
/** Reads res.body via its stream reader, throwing once the running total exceeds maxBytes -- catches a chunked/compressed body a Content-Length check alone would miss. */
async function readBoundedBody(res, maxBytes) {
    if (!res.body)
        return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
/** The real, network-touching IHttpClient -- every default fetch path shares one instance, so the ISsrfGuard/size-bound checks live here once instead of at each call site. */
export function createDefaultHttpClient(guard = new DefaultSsrfGuard(), maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) {
    return {
        async fetch(req) {
            await guard.assertAllowed(req.url);
            const res = await globalThis.fetch(req.url, {
                signal: req.signal,
                headers: req.headers,
            });
            // Single-use, like the real Response body -- whichever accessor is called first wins.
            let bodyRead;
            const readOnce = () => (bodyRead ??= readBoundedBody(res, maxResponseBytes));
            return {
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                headers: { get: (name) => res.headers.get(name) },
                text: async () => new TextDecoder().decode(await readOnce()),
                arrayBuffer: async () => {
                    const bytes = await readOnce();
                    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                },
            };
        },
    };
}
const sharedDefaultHttpClient = createDefaultHttpClient();
/**
 * Spider a single URL and return a fully structured SpideredPage.
 *
 * Pass `view: "lean"` to skip chunking and markdown conversion — returns a
 * LeanPage with only identity, metadata, and the heading/link outline.
 * Significantly faster (~3×) and uses far fewer tokens in agent context.
 *
 * Errors are returned as thrown exceptions with a descriptive message rather
 * than crashing silently. Common cases:
 * - Non-HTTP URLs throw immediately with a clear message.
 * - HTTP errors include the status code.
 * - JS-rendered pages (wordCount === 0) include a hint.
 * - Timeouts include the configured limit.
 *
 * @example
 * // Full page — chunks, markdown, all metadata
 * const page = await spider("https://example.com")
 *
 * @example
 * // Lean overview — no body text, ideal for navigation decisions
 * const lean = await spider("https://example.com", { view: "lean" })
 */
// ---------------------------------------------------------------------------
// Image fetching
// ---------------------------------------------------------------------------
/** Detect MIME type from a URL path extension, defaulting to image/jpeg. */
function mimeFromUrl(src) {
    const ext = src.split("?")[0].split(".").pop()?.toLowerCase();
    const map = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        avif: "image/avif",
    };
    return map[ext ?? ""] ?? "image/jpeg";
}
/** Hydrate pure image candidates after extraction. Failed image fetches are silently skipped. */
async function fetchImages(candidates, httpClient, throttle) {
    const results = [];
    for (const { src, alt } of candidates) {
        if (src.startsWith("data:")) {
            const match = /^data:([^;]+);base64,(.+)$/.exec(src);
            if (match)
                results.push({ src, mimeType: match[1], alt, base64: match[2] });
            continue;
        }
        try {
            if (throttle)
                await throttle.wait(src);
            const res = await httpClient.fetch({
                url: src,
                headers: { "User-Agent": "web-spider/0.1", Accept: "image/*" },
            });
            if (!res.ok)
                continue;
            throttle?.success(src);
            const buf = await res.arrayBuffer();
            const base64 = Buffer.from(buf).toString("base64");
            const contentType = res.headers.get("content-type");
            const mimeType = contentType?.split(";")[0].trim() || mimeFromUrl(src);
            results.push({ src, mimeType, alt, base64 });
        }
        catch {
            // A missing image must never fail the page scrape.
        }
    }
    return results;
}
/** Minimal HTML-text escape for wrapping a MediaWiki API title in a synthetic <title> tag. */
function escapeHtmlText(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export async function spider(url, opts) {
    const { timeoutMs = 30_000, userAgent = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)", view = "full", rootSelector, excludeSelectors, tokenBudget, pdfPageStart, pdfPageEnd, throttle, robotsCache, httpClient, ssrfGuard, maxResponseBytes, captureImages = false, maxImages = 10, preferLlmsTxt = false, preferMarkdownVariant = false, preferMediaWiki = false, preferGitHub = false, githubToken, contentExtractors = [], contentSources = [], } = opts ?? {};
    // ssrfGuard/maxResponseBytes only configure the default client -- a caller-supplied httpClient is used as given.
    const client = httpClient ??
        (ssrfGuard !== undefined || maxResponseBytes !== undefined
            ? createDefaultHttpClient(ssrfGuard, maxResponseBytes)
            : sharedDefaultHttpClient);
    // Poka-yoke: reject non-HTTP URLs immediately with a clear message.
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch {
        throw new Error(`Invalid URL: "${url}" — must be a fully-qualified http/https URL`);
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error(`Unsupported protocol "${parsedUrl.protocol}" — only http and https are supported`);
    }
    const extractionOptions = {
        view,
        rootSelector,
        excludeSelectors,
        tokenBudget,
        pdfPageStart,
        pdfPageEnd,
        captureImages,
        maxImages,
    };
    const extract = async (resource) => extractFetchedResource(resource, extractionOptions, contentExtractors);
    // Check robots.txt before fetching.
    if (robotsCache) {
        const { allowed, crawlDelayMs } = await robotsCache.check(url);
        if (!allowed)
            throw new Error(`Blocked by robots.txt: ${url}`);
        if (crawlDelayMs && throttle) {
            throttle.setDomainDelay(parsedUrl.hostname, crawlDelayMs);
        }
    }
    // Caller-supplied ContentSourceStrategies: tried first, in order, ahead of
    // the legacy preferX flags below — the general extension point new site
    // adapters plug into without editing spider() itself. Only attempted after
    // the robots.txt check above already passed for this host.
    for (const source of contentSources) {
        if (!source.matches(url))
            continue;
        const result = await source.fetch({ url, httpClient: client, timeoutMs, userAgent });
        if (!result)
            continue;
        const resultDomain = new URL(result.url).hostname.replace(/^www\./, "");
        const { page } = await extract({
            url: result.url,
            domain: resultDomain,
            fetchedAt: new Date().toISOString(),
            contentType: result.contentType,
            text: result.text,
        });
        return { ...page, ...(result.title ? { title: result.title } : {}), viaStrategy: source.name };
    }
    // llms.txt strategy: cheap probe before the normal fetch+Readability path.
    // Only attempted after the robots.txt check above already passed for this
    // host, so a site-wide Disallow still blocks this too. A miss falls
    // through to the normal path unchanged, as if preferLlmsTxt were never set.
    if (preferLlmsTxt) {
        const probe = await probeLlmsTxt(url, client, { timeoutMs, userAgent });
        if (probe) {
            const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
            const { page } = await extract({
                url: probe.url,
                domain: probeDomain,
                fetchedAt: new Date().toISOString(),
                contentType: probe.contentType,
                text: probe.content,
            });
            return { ...page, viaStrategy: "llms.txt" };
        }
    }
    // .md URL-suffix strategy: same page, cleaner variant. Checked after
    // preferLlmsTxt above (a broader site-wide index) misses or is disabled.
    if (preferMarkdownVariant) {
        const probe = await probeMarkdownVariant(url, client, { timeoutMs, userAgent });
        if (probe) {
            const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
            const { page } = await extract({
                url: probe.url,
                domain: probeDomain,
                fetchedAt: new Date().toISOString(),
                contentType: probe.contentType,
                text: probe.content,
            });
            return { ...page, viaStrategy: "markdown-suffix" };
        }
    }
    // GitHub API strategy: repo/issue/PR metadata via the real REST API
    // instead of scraping GitHub's JS-heavy rendered pages. Same resource,
    // different mechanism, so url stays the originally requested one.
    if (preferGitHub) {
        const result = await queryGitHub(url, client, { token: githubToken, timeoutMs, userAgent });
        if (result) {
            const { page } = await extract({
                url,
                domain: new URL(url).hostname.replace(/^www\./, ""),
                fetchedAt: new Date().toISOString(),
                contentType: "text/markdown; charset=utf-8",
                text: result.markdown,
            });
            return { ...page, title: result.title, viaStrategy: "github" };
        }
    }
    let responseText = "";
    let responseBytes;
    let fetchError = null;
    let contentTypeHeader = null;
    let viaMediaWiki = false;
    // MediaWiki strategy: query the platform's real API for the article's own
    // content HTML instead of scraping the rendered wiki page. Sets html/
    // contentTypeHeader directly and skips the fetch loop below entirely on a
    // hit; a miss (not an article URL, or not a MediaWiki site) falls through
    // to the normal fetch unchanged.
    if (preferMediaWiki) {
        const pageTitle = extractWikiPageTitle(url);
        if (pageTitle) {
            const siteInfo = await detectMediaWiki(url, client, { timeoutMs, userAgent });
            if (siteInfo) {
                const page = await queryMediaWikiPage(siteInfo.apiUrl, pageTitle, client, { timeoutMs, userAgent });
                if (page) {
                    responseText = `<html><head><title>${escapeHtmlText(page.title)}</title></head><body>${page.html}</body></html>`;
                    contentTypeHeader = "text/html; charset=utf-8";
                    viaMediaWiki = true;
                }
            }
        }
    }
    // Fetch with optional throttle + retry on 429/503 — skipped entirely when
    // the MediaWiki strategy above already produced content.
    const maxRetries = throttle?.maxRetries ?? 0;
    for (let attempt = 0; !viaMediaWiki && attempt <= maxRetries; attempt++) {
        if (throttle)
            await throttle.wait(url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await client.fetch({
                url,
                signal: controller.signal,
                headers: { "User-Agent": userAgent, Accept: "text/html, application/pdf;q=0.9" },
            });
        }
        catch (err) {
            clearTimeout(timer);
            if (controller.signal.aborted || isLikelyFetchTransportFailure(err)) {
                throw toFetchTransportError(err, { timedOut: controller.signal.aborted });
            }
            throw err;
        }
        clearTimeout(timer);
        if (res.status === 429 || res.status === 503) {
            if (throttle && attempt < maxRetries) {
                throttle.rateLimit(url, res.headers.get("Retry-After"));
                fetchError = new Error(`HTTP ${res.status} — retrying (attempt ${attempt + 1}/${maxRetries})`);
                continue;
            }
            throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
        }
        if (!res.ok)
            throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
        contentTypeHeader = res.headers.get("content-type");
        throttle?.success(url);
        responseBytes = new Uint8Array(await res.arrayBuffer());
        responseText = new TextDecoder().decode(responseBytes);
        if (responseBytes.byteLength === 0) {
            // Preserve compatibility with structural IHttpClient fakes/adapters that
            // historically supplied text() but used an empty arrayBuffer placeholder.
            // A real consumed empty Response rejects text(); empty remains correct.
            try {
                responseText = await res.text();
                responseBytes = new TextEncoder().encode(responseText);
            }
            catch {
                // The real response body was empty and has already been consumed.
            }
        }
        fetchError = null;
        break;
    }
    if (fetchError)
        throw fetchError;
    const resource = {
        url,
        domain: new URL(url).hostname.replace(/^www\./, ""),
        fetchedAt: new Date().toISOString(),
        contentType: contentTypeHeader,
        text: responseText,
        ...(responseBytes ? { bytes: responseBytes } : {}),
    };
    const { page, imageCandidates } = await extract(resource);
    const images = imageCandidates ? await fetchImages(imageCandidates, client, throttle) : undefined;
    return {
        ...page,
        ...(images ? { images } : {}),
        ...(viaMediaWiki ? { viaStrategy: "mediawiki" } : {}),
    };
}
//# sourceMappingURL=spider.js.map