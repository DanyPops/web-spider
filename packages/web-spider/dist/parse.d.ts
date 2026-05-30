/**
 * DOM parsing helpers.
 *
 * Owns the DOM parsing dependency. spider.ts calls these after fetching HTML;
 * it never touches the DOM library directly.
 */
import type { Link, SpideredPage } from "./types.js";
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
//# sourceMappingURL=parse.d.ts.map