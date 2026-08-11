import { Readability } from "@mozilla/readability";
import { chunk, toMarkdown } from "../extract/convert.js";
import { extractCanonicalUrl, extractHeadings, extractJsonLd, extractLinks, extractOpenGraph, extractTags, extractTwitterCard, parseDom, } from "../extract/parse.js";
import { buildTree } from "../extract/tree.js";
import { toLean } from "../extract/views.js";
import { classifyContentType } from "./content-type.js";
import { PdfContentExtractor } from "./pdf-extractor.js";
const WORDS_PER_MINUTE = 200;
const THIN_CONTENT_WORD_THRESHOLD = 20;
function requireText(resource) {
    if (resource.text === undefined) {
        throw new Error(`Cannot extract textual content from "${resource.url}" — the response body was not decoded as text`);
    }
    return resource.text;
}
/** Pretty-prints parseable JSON and leaves invalid JSON/JSONL unchanged. */
function prettyPrintIfJson(rawText) {
    try {
        return JSON.stringify(JSON.parse(rawText), null, 2);
    }
    catch {
        return rawText;
    }
}
function titleFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
    }
    catch {
        return url;
    }
}
function extractMarkdownHeadings(text) {
    const headings = [];
    for (const line of text.split("\n")) {
        const match = /^(#{1,3})\s+(.+)/.exec(line.trim());
        if (match)
            headings.push({ level: match[1].length, text: match[2].trim() });
    }
    return headings;
}
function extractImageCandidates(articleHtml, pageUrl, maxImages) {
    const doc = parseDom(articleHtml, pageUrl);
    const candidates = [];
    for (const element of [...doc.querySelectorAll("img")].slice(0, maxImages)) {
        const rawSrc = element.getAttribute("src") ?? "";
        if (!rawSrc)
            continue;
        if (rawSrc.startsWith("data:")) {
            candidates.push({ src: rawSrc, alt: element.getAttribute("alt") ?? "" });
            continue;
        }
        try {
            candidates.push({ src: new URL(rawSrc, pageUrl).toString(), alt: element.getAttribute("alt") ?? "" });
        }
        catch {
            // Invalid image references are not extraction candidates.
        }
    }
    return candidates;
}
const textualExtractor = {
    supports(resource) {
        return ["text", "json", "xml"].includes(classifyContentType(resource.contentType));
    },
    async extract(resource, options) {
        const rawText = requireText(resource);
        const text = classifyContentType(resource.contentType) === "json" ? prettyPrintIfJson(rawText) : rawText;
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const headings = extractMarkdownHeadings(text);
        const title = titleFromUrl(resource.url);
        const readingTimeMinutes = Math.ceil(wordCount / WORDS_PER_MINUTE);
        const contentTypeField = resource.contentType ? { contentType: resource.contentType } : {};
        if (options.view === "lean") {
            return {
                page: {
                    view: "lean",
                    url: resource.url,
                    domain: resource.domain,
                    fetchedAt: resource.fetchedAt,
                    title,
                    lang: "",
                    tags: [],
                    wordCount,
                    readingTimeMinutes,
                    chunkCount: Math.max(0, Math.floor(wordCount / 150)),
                    headings: headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`),
                    links: [],
                    ...contentTypeField,
                },
            };
        }
        const chunks = chunk(text, resource.url);
        const base = {
            url: resource.url,
            domain: resource.domain,
            fetchedAt: resource.fetchedAt,
            title,
            description: "",
            author: "",
            publishedAt: "",
            lang: "",
            tags: [],
            wordCount,
            readingTimeMinutes,
            headings,
            chunks,
            links: [],
            markdown: text,
            ...contentTypeField,
        };
        if (options.view === "tree") {
            return { page: { ...base, view: "tree", tree: { tag: "text", path: "text", text } } };
        }
        return { page: base };
    },
};
const htmlExtractor = {
    supports(resource) {
        return classifyContentType(resource.contentType) === "html";
    },
    async extract(resource, options) {
        const html = requireText(resource);
        const doc = parseDom(html, resource.url);
        if (options.excludeSelectors) {
            for (const selector of options.excludeSelectors
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)) {
                for (const element of [...doc.querySelectorAll(selector)])
                    element.remove();
            }
        }
        if (options.rootSelector) {
            const root = doc.querySelector(options.rootSelector);
            if (root)
                doc.body.innerHTML = root.outerHTML;
        }
        const links = extractLinks(doc, resource.url);
        const canonicalUrl = extractCanonicalUrl(doc, resource.url);
        // Extracted before Readability.parse() runs -- Readability mutates/strips
        // the document as part of its own cleanup pass, including <script> tags,
        // so JSON-LD (and og:/twitter: <meta> tags, for the same reason) must be
        // read from the original <head> first, exactly like links/canonicalUrl above.
        const openGraph = extractOpenGraph(doc);
        const twitterCard = extractTwitterCard(doc);
        const jsonLd = extractJsonLd(doc);
        const hasScript = doc.querySelector("script") !== null;
        const readabilityResult = new Readability(doc).parse();
        // Readability only returns null when it finds literally zero text -- a
        // script-hydrated shell with a few nav links otherwise "succeeds" with
        // near-empty content. A real static page this thin has no reason to also
        // ship a <script> tag, so treat that combination as jsRendered too.
        const articleWordCount = (readabilityResult?.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
        const jsRendered = !readabilityResult || (hasScript && articleWordCount < THIN_CONTENT_WORD_THRESHOLD);
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
        const meta = (name) => {
            const element = doc.querySelector(`meta[name="${name}"]`) ??
                doc.querySelector(`meta[property="og:${name}"]`) ??
                doc.querySelector(`meta[property="${name}"]`);
            return (element?.getAttribute("content") ?? "").trim();
        };
        const headings = extractHeadings(article.content ?? "");
        const tags = extractTags(doc);
        const identity = {
            url: resource.url,
            domain: resource.domain,
            fetchedAt: resource.fetchedAt,
            ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
            title: article.title ?? meta("title"),
            description: meta("description"),
            author: article.byline ?? meta("author"),
            publishedAt: meta("article:published_time") ?? meta("date"),
            lang: doc.documentElement?.lang ?? "en",
            tags,
            headings,
            links,
            // Omitted (not even an empty object/array) when absent -- see SpideredPage's
            // own doc comments on these three fields for why they're never spread into
            // the default markdown/lean/tree views regardless of being present here.
            ...(Object.keys(openGraph).length > 0 ? { openGraph } : {}),
            ...(Object.keys(twitterCard).length > 0 ? { twitterCard } : {}),
            ...(jsonLd.length > 0 ? { jsonLd } : {}),
        };
        if (options.view === "lean") {
            const textContent = (article.textContent ?? "").trim();
            const wordCount = textContent.split(/\s+/).filter(Boolean).length;
            const full = {
                ...identity,
                wordCount,
                readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
                chunks: [],
                markdown: "",
            };
            return {
                page: { ...toLean(full), chunkCount: Math.max(0, Math.floor(wordCount / 150)), ...(jsRendered ? { jsRendered: true } : {}) },
            };
        }
        const markdown = toMarkdown(article.content ?? "", { keepImages: options.captureImages });
        const wordCount = markdown.split(/\s+/).filter(Boolean).length;
        const imageCandidates = options.captureImages
            ? extractImageCandidates(article.content ?? "", resource.url, options.maxImages)
            : undefined;
        if (options.view === "tree") {
            return {
                page: {
                    ...identity,
                    view: "tree",
                    wordCount,
                    readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
                    chunks: chunk(markdown, resource.url),
                    markdown,
                    tree: buildTree(article.content ?? "", resource.url),
                },
                ...(imageCandidates ? { imageCandidates } : {}),
            };
        }
        let chunks = chunk(markdown, resource.url);
        if (options.tokenBudget !== undefined) {
            let remaining = options.tokenBudget * 4;
            let first = true;
            chunks = chunks.filter((part) => {
                if (!first && remaining <= 0)
                    return false;
                first = false;
                remaining -= part.text.length;
                return true;
            });
        }
        const finalMarkdown = options.tokenBudget !== undefined ? chunks.map((part) => part.text).join("\n\n") : markdown;
        return {
            page: {
                ...identity,
                wordCount,
                readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
                chunks,
                markdown: finalMarkdown,
                ...(jsRendered ? { jsRendered: true } : {}),
            },
            ...(imageCandidates ? { imageCandidates } : {}),
        };
    },
};
const BUILT_IN_EXTRACTORS = [new PdfContentExtractor(), htmlExtractor, textualExtractor];
/** Select the first caller-provided Strategy that supports the resource, then fall back to built-ins. */
export async function extractFetchedResource(resource, options, customExtractors = []) {
    const extractor = [...customExtractors, ...BUILT_IN_EXTRACTORS].find((candidate) => candidate.supports(resource));
    if (!extractor) {
        throw new Error(`Cannot extract content from "${resource.url}" — server returned "${resource.contentType ?? "an unknown content type"}", which web-spider cannot parse as text or structure`);
    }
    return extractor.extract(resource, options);
}
//# sourceMappingURL=content-extractor.js.map