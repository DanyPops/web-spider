/**
 * DOM parsing helpers.
 *
 * Owns the DOM parsing dependency. spider.ts calls these after fetching HTML;
 * it never touches the DOM library directly.
 */
import { parseHTML } from "linkedom";
// ---------------------------------------------------------------------------
// DOM creation
// ---------------------------------------------------------------------------
/**
 * Parse raw HTML into a DOM Document.
 * Uses linkedom — a lightweight server-side DOM that has no CSS engine,
 * no module-level Maps, and a flat CJS dependency tree. Safe to load
 * through jiti's transform pipeline without nativeModules workarounds.
 */
export function parseDom(html, url) {
    return parseHTML(html, { url }).document;
}
// ---------------------------------------------------------------------------
// Nav classification
// ---------------------------------------------------------------------------
const NAV_CLASS_RE = /^(nav|navbar|navigation|menu|menubar|header|footer|sidebar|breadcrumb|topbar|toolbar|site-nav|main-nav|primary-nav|global-nav)$/i;
/** True if el or any ancestor up to 5 levels looks like navigation chrome. */
export function isNavElement(el) {
    if (el.closest("nav, header, footer, aside"))
        return true;
    if (el.closest("[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary']"))
        return true;
    let node = el;
    for (let i = 0; i < 5; i++) {
        if (!node)
            break;
        for (const cls of node.classList) {
            if (NAV_CLASS_RE.test(cls))
                return true;
        }
        node = node.parentElement;
    }
    return false;
}
// ---------------------------------------------------------------------------
// Link text extraction
// ---------------------------------------------------------------------------
/** Extract visible text from an anchor, skipping SVG subtrees. */
export function anchorText(a) {
    if (!a.querySelector("svg")) {
        return (a.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    const clone = a.cloneNode(true);
    for (const svg of [...clone.querySelectorAll("svg")])
        svg.remove();
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------
/** Extract outbound links from the DOM, classified as body or nav. */
export function extractLinks(doc, baseUrl) {
    const origin = new URL(baseUrl).origin;
    return Array.from(doc.querySelectorAll("a[href]"))
        .map((a) => {
        const href = a.href;
        const text = anchorText(a)
            .replace(/\b(open_in_new|navigate_next|navigate_before|arrow_drop_down|arrow_drop_up|chevron_right|chevron_left|expand_more|expand_less)\b/g, "")
            .replace(/\s+/g, " ")
            .trim();
        if (!href || !text || href.startsWith("javascript:"))
            return null;
        return {
            href,
            text,
            isExternal: !href.startsWith(origin),
            rel: isNavElement(a) ? "nav" : "body",
        };
    })
        .filter((l) => l !== null)
        .slice(0, 200);
}
// ---------------------------------------------------------------------------
// Heading extraction
// ---------------------------------------------------------------------------
/** Extract h1/h2/h3 headings from Readability article HTML. */
export function extractHeadings(html) {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    const headings = [];
    document.querySelectorAll("h1, h2, h3").forEach((el) => {
        const level = parseInt(el.tagName[1], 10);
        const text = (el.textContent ?? "").trim();
        if (text)
            headings.push({ level, text });
    });
    return headings;
}
// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------
/** Extract topic tags from meta keywords and article:tag. */
export function extractTags(doc) {
    const tags = new Set();
    const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? "";
    for (const k of keywords
        .split(/[,;]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)) {
        tags.add(k);
    }
    doc.querySelectorAll('meta[property="article:tag"], meta[name="article:tag"]').forEach((el) => {
        const t = el.getAttribute("content")?.trim().toLowerCase();
        if (t)
            tags.add(t);
    });
    const section = doc.querySelector('meta[property="article:section"]')?.getAttribute("content") ??
        doc.querySelector('meta[property="og:article:section"]')?.getAttribute("content");
    if (section)
        tags.add(section.trim().toLowerCase());
    return [...tags].slice(0, 20);
}
// ---------------------------------------------------------------------------
// Canonical URL extraction
// ---------------------------------------------------------------------------
/** Extract canonical URL from link[rel=canonical] or og:url. */
export function extractCanonicalUrl(doc, fetchedUrl) {
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
        doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
    if (!canonical)
        return undefined;
    const norm = (u) => u.replace(/\/$/, "");
    return norm(canonical) !== norm(fetchedUrl) ? canonical : undefined;
}
// ---------------------------------------------------------------------------
// Structured metadata: Open Graph, Twitter Cards, JSON-LD
// ---------------------------------------------------------------------------
/**
 * Collects every `<meta property="og:...">` (or `<meta name="og:...">` --
 * some real-world pages use `name` instead of `property`, contrary to the
 * spec, and both are read for robustness) into a flat map keyed by the
 * property's full name including namespace (e.g. "og:image:width"). The
 * first occurrence of a repeated property wins, per the Open Graph
 * protocol's own documented conflict rule (https://ogp.me/#array): "The
 * first tag (from top to bottom) is given preference during conflicts."
 */
export function extractOpenGraph(doc) {
    const result = {};
    for (const el of doc.querySelectorAll('meta[property^="og:"], meta[name^="og:"]')) {
        const key = el.getAttribute("property") ?? el.getAttribute("name");
        const value = el.getAttribute("content");
        if (key && value !== null && !(key in result))
            result[key] = value;
    }
    return result;
}
/**
 * Collects every `<meta name="twitter:...">` into a flat map keyed by the
 * property's full name (e.g. "twitter:card", "twitter:image:alt"). Twitter
 * Cards use `name`, not `property` -- unlike Open Graph, there is no widely
 * used `property` variant to also check. Same first-occurrence-wins rule as
 * extractOpenGraph, for consistency.
 */
export function extractTwitterCard(doc) {
    const result = {};
    for (const el of doc.querySelectorAll('meta[name^="twitter:"]')) {
        const key = el.getAttribute("name");
        const value = el.getAttribute("content");
        if (key && value !== null && !(key in result))
            result[key] = value;
    }
    return result;
}
/**
 * Parses every `<script type="application/ld+json">` block on the page, in
 * document order. A block whose JSON top-level value is an array is spread
 * into individual entries (a common pattern for pages describing several
 * schema.org entities, e.g. an Article plus a BreadcrumbList); any other
 * value is pushed as a single entry. A block that fails to parse is skipped
 * -- one malformed script tag must never fail extraction for the rest of
 * the page (fails open, matching every other best-effort signal here).
 */
export function extractJsonLd(doc) {
    const result = [];
    for (const el of doc.querySelectorAll('script[type="application/ld+json"]')) {
        const raw = el.textContent?.trim();
        if (!raw)
            continue;
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                result.push(...parsed);
            else
                result.push(parsed);
        }
        catch {
            // Malformed JSON-LD is skipped, not thrown -- see doc comment above.
        }
    }
    return result;
}
//# sourceMappingURL=parse.js.map