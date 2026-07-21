/**
 * Output-shaping helpers — ported verbatim from packages/pi-extension/src/format.ts
 * so the daemon's `fetch`/`crawl` operations produce the exact same JSON shapes
 * the tool already returns (design doc §3: "reuse today's pi-extension Params/
 * output shapes verbatim — this is a backend swap, not an API change").
 *
 * This is an intentional, acknowledged duplication for the span of this task:
 * the extension-client task will make the Pi extension consume these
 * operation outputs directly and remove its own copy, leaving this module
 * as the single source of truth.
 */
import type { SpideredPage } from "@danypops/web-spider";

/** Remove keys whose value is an empty string, empty array, false, or undefined. Keeps 0 and null. */
export function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(
			([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0),
		),
	);
}

/** Body links only — content references, not navigation chrome. */
export function bodyLinks(page: SpideredPage): Array<{ href: string; text: string }> {
	return page.links
		.filter((l) => l.rel === "body")
		.map((l) => ({ href: l.href, text: l.text }));
}

/** Count of navigation links (menus, footers, breadcrumbs). */
export function navLinksCount(page: SpideredPage): number {
	return page.links.filter((l) => l.rel === "nav").length;
}

/** Headings as flat markdown strings: "## Section Name". */
export function headingStrings(page: SpideredPage): string[] {
	return page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`);
}

export function leanOutput(page: SpideredPage): Record<string, unknown> {
	return omitEmpty({
		url: page.url,
		title: page.title,
		description: page.description,
		author: page.author,
		publishedAt: page.publishedAt,
		tags: page.tags,
		wordCount: page.wordCount,
		headings: headingStrings(page),
		bodyLinks: bodyLinks(page),
		navLinksCount: navLinksCount(page) || undefined,
		jsRendered: page.jsRendered || undefined,
	});
}

export function markdownOutput(page: SpideredPage): Record<string, unknown> {
	return omitEmpty({
		url: page.url,
		title: page.title,
		description: page.description,
		author: page.author,
		publishedAt: page.publishedAt,
		wordCount: page.wordCount,
		markdown: page.markdown,
		jsRendered: page.jsRendered || undefined,
	});
}

export function linksOutput(page: SpideredPage): Record<string, unknown> {
	return omitEmpty({
		url: page.url,
		title: page.title,
		bodyLinks: bodyLinks(page),
		navLinksCount: navLinksCount(page) || undefined,
	});
}

/** A single highlights hit — full chunk text only (never both text and a redundant snippet). */
export function highlightHit(
	h: { heading: string; score: number; snippet: string; chunkId?: string },
	chunks: SpideredPage["chunks"],
): Record<string, unknown> {
	const text = h.chunkId
		? (chunks.find((c) => c.id === h.chunkId)?.text ?? h.snippet)
		: h.snippet;
	return omitEmpty({
		heading: h.heading,
		score: h.score,
		text,
	});
}
