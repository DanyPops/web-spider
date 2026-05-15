import { Readability } from "@mozilla/readability";
import { chunk, toMarkdown } from "./convert.js";
import { extractCanonicalUrl, extractHeadings, extractLinks, extractTags, parseDom } from "./parse.js";
import { buildTree } from "./tree.js";
import { toLean } from "./views.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WORDS_PER_MINUTE = 200;
// ---------------------------------------------------------------------------
// Default HTTP client adapter
// ---------------------------------------------------------------------------
const defaultHttpClient = {
    async fetch(req) {
        return globalThis.fetch(req.url, {
            signal: req.signal,
            headers: req.headers,
        });
    },
};
export async function spider(url, opts) {
    const { timeoutMs = 10_000, userAgent = "web-spider/0.1 (AI agent research tool; +https://github.com/dpopsuev)", view = "full", rootSelector, excludeSelectors, tokenBudget, throttle, robotsCache, httpClient = defaultHttpClient, } = opts ?? {};
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
    // Check robots.txt before fetching.
    if (robotsCache) {
        const { allowed, crawlDelayMs } = await robotsCache.check(url);
        if (!allowed)
            throw new Error(`Blocked by robots.txt: ${url}`);
        if (crawlDelayMs && throttle) {
            throttle.setDomainDelay(parsedUrl.hostname, crawlDelayMs);
        }
    }
    // Fetch with optional throttle + retry on 429/503.
    const maxRetries = throttle?.maxRetries ?? 0;
    let html = "";
    let fetchError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (throttle)
            await throttle.wait(url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await httpClient.fetch({
                url,
                signal: controller.signal,
                headers: { "User-Agent": userAgent, Accept: "text/html" },
            });
        }
        catch (err) {
            clearTimeout(timer);
            if (err instanceof Error && err.name === "AbortError") {
                throw new Error(`Timeout after ${timeoutMs}ms — ${url}`);
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
        throttle?.success(url);
        html = await res.text();
        fetchError = null;
        break;
    }
    if (fetchError)
        throw fetchError;
    // Parse DOM via parse.ts — keeps the JSDOM dependency in one module.
    const doc = parseDom(html, url);
    // Apply excludeSelectors before Readability strips the DOM.
    if (excludeSelectors) {
        for (const sel of excludeSelectors
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)) {
            for (const el of [...doc.querySelectorAll(sel)])
                el.remove();
        }
    }
    // Scope to rootSelector: replace body content with the matched element.
    if (rootSelector) {
        const root = doc.querySelector(rootSelector);
        if (root) {
            doc.body.innerHTML = root.outerHTML;
        }
    }
    const links = extractLinks(doc, url);
    const canonicalUrl = extractCanonicalUrl(doc, url);
    // Readability content extraction (Firefox Reader View engine).
    const readabilityResult = new Readability(doc).parse();
    const jsRendered = !readabilityResult;
    // Graceful degradation: if Readability finds nothing, return a partial page
    // with jsRendered:true rather than throwing. The agent can decide what to do.
    const article = readabilityResult ?? {
        title: (doc.querySelector("title")?.textContent ?? "").trim(),
        content: "",
        textContent: "",
        length: 0,
        excerpt: "",
        byline: "",
        dir: "",
        site_name: "",
        lang: "",
        publishedTime: null,
        readingTimeMinutes: 0,
    };
    const domain = new URL(url).hostname.replace(/^www\./, "");
    const fetchedAt = new Date().toISOString();
    const meta = (name) => {
        const el = doc.querySelector(`meta[name="${name}"]`) ??
            doc.querySelector(`meta[property="og:${name}"]`) ??
            doc.querySelector(`meta[property="${name}"]`);
        return (el?.getAttribute("content") ?? "").trim();
    };
    // headings must come before tags so the heading fallback is available.
    const headings = extractHeadings(article.content ?? "");
    const tags = extractTags(doc);
    // ---------------------------------------------------------------------------
    // Lean fast-path — skip turndown + chunking entirely
    // ---------------------------------------------------------------------------
    if (view === "lean") {
        const textContent = (article.textContent ?? "").trim();
        const wordCount = textContent.split(/\s+/).filter(Boolean).length;
        const chunkCount = Math.max(0, Math.floor(wordCount / 150));
        const full = {
            url,
            domain,
            fetchedAt,
            ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
            title: article.title ?? meta("title"),
            description: meta("description"),
            author: article.byline ?? meta("author"),
            publishedAt: meta("article:published_time") ?? meta("date"),
            lang: doc.documentElement.lang ?? "en",
            tags,
            wordCount,
            readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
            chunks: [], // placeholder — toLean reads chunks.length
            headings,
            links,
            markdown: "",
        };
        const lean = toLean(full);
        return { ...lean, chunkCount, ...(jsRendered ? { jsRendered: true } : {}) };
    }
    // ---------------------------------------------------------------------------
    // Tree path — build semantic DOM tree, then also produce full markdown
    // ---------------------------------------------------------------------------
    if (view === "tree") {
        const tree = buildTree(article.content ?? "", url);
        const markdown = toMarkdown(article.content ?? "");
        const wordCount = markdown.split(/\s+/).filter(Boolean).length;
        const chunks = chunk(markdown, url);
        return {
            view: "tree",
            url,
            domain,
            fetchedAt,
            ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
            title: article.title ?? meta("title"),
            description: meta("description"),
            author: article.byline ?? meta("author"),
            publishedAt: meta("article:published_time") ?? meta("date"),
            lang: doc.documentElement.lang ?? "en",
            tags,
            wordCount,
            readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
            headings,
            chunks,
            links,
            markdown,
            tree,
        };
    }
    // ---------------------------------------------------------------------------
    // Full path — turndown + chunk
    // ---------------------------------------------------------------------------
    const markdown = toMarkdown(article.content ?? "");
    const wordCount = markdown.split(/\s+/).filter(Boolean).length;
    // Chunk-aware tokenBudget: select whole chunks up to the budget rather
    // than slicing markdown mid-sentence. Preserves chunk boundaries and
    // returns the richest complete content that fits.
    let allChunks = chunk(markdown, url);
    if (tokenBudget !== undefined) {
        const charBudget = tokenBudget * 4;
        let remaining = charBudget;
        let first = true;
        allChunks = allChunks.filter((c) => {
            // Always include at least the first chunk — agents need something
            // even if it exceeds the budget.
            if (!first && remaining <= 0)
                return false;
            first = false;
            remaining -= c.text.length;
            return true;
        });
    }
    // Reconstruct markdown from selected chunks for full-page consumers.
    const finalMarkdown = tokenBudget !== undefined
        ? allChunks.map((c) => c.text).join("\n\n")
        : markdown;
    return {
        url,
        domain,
        fetchedAt,
        ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
        title: article.title ?? meta("title"),
        description: meta("description"),
        author: article.byline ?? meta("author"),
        publishedAt: meta("article:published_time") ?? meta("date"),
        lang: doc.documentElement.lang ?? "en",
        tags,
        wordCount,
        readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
        headings,
        chunks: allChunks,
        links,
        markdown: finalMarkdown,
        ...(jsRendered ? { jsRendered: true } : {}),
    };
}
//# sourceMappingURL=spider.js.map