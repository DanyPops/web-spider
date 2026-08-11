/**
 * DOM parsing helpers.
 *
 * Owns the DOM parsing dependency. spider.ts calls these after fetching HTML;
 * it never touches the DOM library directly.
 */
import type { Link, SpideredPage } from "../types.js";
/**
 * Parse raw HTML into a DOM Document.
 * Uses linkedom — a lightweight server-side DOM that has no CSS engine,
 * no module-level Maps, and a flat CJS dependency tree. Safe to load
 * through jiti's transform pipeline without nativeModules workarounds.
 */
export declare function parseDom(html: string, url: string): Document;
/** True if el or any ancestor up to 5 levels looks like navigation chrome. */
export declare function isNavElement(el: Element): boolean;
/** Extract visible text from an anchor, skipping SVG subtrees. */
export declare function anchorText(a: Element): string;
/** Extract outbound links from the DOM, classified as body or nav. */
export declare function extractLinks(doc: Document, baseUrl: string): Link[];
/** Extract h1/h2/h3 headings from Readability article HTML. */
export declare function extractHeadings(html: string): SpideredPage["headings"];
/** Extract topic tags from meta keywords and article:tag. */
export declare function extractTags(doc: Document): string[];
/** Extract canonical URL from link[rel=canonical] or og:url. */
export declare function extractCanonicalUrl(doc: Document, fetchedUrl: string): string | undefined;
/**
 * Collects every `<meta property="og:...">` (or `<meta name="og:...">` --
 * some real-world pages use `name` instead of `property`, contrary to the
 * spec, and both are read for robustness) into a flat map keyed by the
 * property's full name including namespace (e.g. "og:image:width"). The
 * first occurrence of a repeated property wins, per the Open Graph
 * protocol's own documented conflict rule (https://ogp.me/#array): "The
 * first tag (from top to bottom) is given preference during conflicts."
 */
export declare function extractOpenGraph(doc: Document): Record<string, string>;
/**
 * Collects every `<meta name="twitter:...">` into a flat map keyed by the
 * property's full name (e.g. "twitter:card", "twitter:image:alt"). Twitter
 * Cards use `name`, not `property` -- unlike Open Graph, there is no widely
 * used `property` variant to also check. Same first-occurrence-wins rule as
 * extractOpenGraph, for consistency.
 */
export declare function extractTwitterCard(doc: Document): Record<string, string>;
/**
 * Parses every `<script type="application/ld+json">` block on the page, in
 * document order. A block whose JSON top-level value is an array is spread
 * into individual entries (a common pattern for pages describing several
 * schema.org entities, e.g. an Article plus a BreadcrumbList); any other
 * value is pushed as a single entry. A block that fails to parse is skipped
 * -- one malformed script tag must never fail extraction for the rest of
 * the page (fails open, matching every other best-effort signal here).
 */
export declare function extractJsonLd(doc: Document): unknown[];
//# sourceMappingURL=parse.d.ts.map