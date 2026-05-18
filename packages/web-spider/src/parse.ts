/**
 * DOM parsing helpers.
 *
 * Owns the JSDOM dependency. spider.ts calls these after fetching HTML;
 * it never touches JSDOM directly.
 */

import { JSDOM, VirtualConsole } from "jsdom";

// Shared silent virtual console — suppresses all jsdomError events (CSS parse
// failures, resource load errors, etc.) so they never reach process.stderr.
// JSDOM's default is (new VirtualConsole()).forwardTo(console), which routes
// every jsdomError to console.error → process.stderr → raw terminal.
// A bare VirtualConsole with no listeners silently drops every event.
const silentConsole = new VirtualConsole();
import type { Link, SpideredPage } from "./types.js";

// ---------------------------------------------------------------------------
// DOM creation
// ---------------------------------------------------------------------------

/**
 * Parse raw HTML into a DOM Document.
 * Centralises the JSDOM dependency — spider.ts calls this instead of
 * importing JSDOM directly, keeping external deps in one place per module.
 */
export function parseDom(html: string, url: string): Document {
	return new JSDOM(html, { url, virtualConsole: silentConsole }).window.document;
}

// ---------------------------------------------------------------------------
// Nav classification
// ---------------------------------------------------------------------------

const NAV_CLASS_RE =
	/^(nav|navbar|navigation|menu|menubar|header|footer|sidebar|breadcrumb|topbar|toolbar|site-nav|main-nav|primary-nav|global-nav)$/i;

/** True if el or any ancestor up to 5 levels looks like navigation chrome. */
export function isNavElement(el: Element): boolean {
	if (el.closest("nav, header, footer, aside")) return true;
	if (
		el.closest(
			"[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary']",
		)
	)
		return true;

	let node: Element | null = el;
	for (let i = 0; i < 5; i++) {
		if (!node) break;
		for (const cls of node.classList) {
			if (NAV_CLASS_RE.test(cls)) return true;
		}
		node = node.parentElement;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Link text extraction
// ---------------------------------------------------------------------------

/** Extract visible text from an anchor, skipping SVG subtrees. */
export function anchorText(a: Element): string {
	if (!a.querySelector("svg")) {
		return (a.textContent ?? "").replace(/\s+/g, " ").trim();
	}
	const clone = a.cloneNode(true) as Element;
	for (const svg of [...clone.querySelectorAll("svg")]) svg.remove();
	return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/** Extract outbound links from the DOM, classified as body or nav. */
export function extractLinks(doc: Document, baseUrl: string): Link[] {
	const origin = new URL(baseUrl).origin;
	return Array.from(doc.querySelectorAll("a[href]"))
		.map((a) => {
			const href = (a as HTMLAnchorElement).href;
			const text = anchorText(a)
				.replace(
					/\b(open_in_new|navigate_next|navigate_before|arrow_drop_down|arrow_drop_up|chevron_right|chevron_left|expand_more|expand_less)\b/g,
					"",
				)
				.replace(/\s+/g, " ")
				.trim();
			if (!href || !text || href.startsWith("javascript:")) return null;

			return {
				href,
				text,
				isExternal: !href.startsWith(origin),
				rel: isNavElement(a) ? ("nav" as const) : ("body" as const),
			} satisfies Link;
		})
		.filter((l): l is Link => l !== null)
		.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Heading extraction
// ---------------------------------------------------------------------------

/** Extract h1/h2/h3 headings from Readability article HTML. */
export function extractHeadings(html: string): SpideredPage["headings"] {
	const dom = new JSDOM(html);
	const headings: SpideredPage["headings"] = [];
	dom.window.document.querySelectorAll("h1, h2, h3").forEach((el) => {
		const level = parseInt(el.tagName[1], 10) as 1 | 2 | 3;
		const text = (el.textContent ?? "").trim();
		if (text) headings.push({ level, text });
	});
	return headings;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

/** Extract topic tags from meta keywords and article:tag. */
export function extractTags(doc: Document): string[] {
	const tags = new Set<string>();

	const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? "";
	for (const k of keywords
		.split(/[,;]/)
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean)) {
		tags.add(k);
	}

	doc.querySelectorAll('meta[property="article:tag"], meta[name="article:tag"]').forEach((el) => {
		const t = el.getAttribute("content")?.trim().toLowerCase();
		if (t) tags.add(t);
	});

	const section =
		doc.querySelector('meta[property="article:section"]')?.getAttribute("content") ??
		doc.querySelector('meta[property="og:article:section"]')?.getAttribute("content");
	if (section) tags.add(section.trim().toLowerCase());

	return [...tags].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Canonical URL extraction
// ---------------------------------------------------------------------------

/** Extract canonical URL from link[rel=canonical] or og:url. */
export function extractCanonicalUrl(doc: Document, fetchedUrl: string): string | undefined {
	const canonical =
		doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
		doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
	if (!canonical) return undefined;
	const norm = (u: string) => u.replace(/\/$/, "");
	return norm(canonical) !== norm(fetchedUrl) ? canonical : undefined;
}
