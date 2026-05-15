/**
 * Agent-optimised output formatters for the web_fetch tool.
 *
 * Every field in every output must be actionable — the agent must be able to
 * make a different decision based on its value. Fields that fail this test are
 * omitted: domain (derivable from url), readingTimeMinutes (wordCount / 200,
 * never acted on), headings inside markdown (already in the body), empty
 * strings / arrays, and the snippet field in highlights (always a substring
 * of the full chunk text that follows it).
 *
 * Link handling: SpideredPage carries rel:"body"|"nav" on every link.
 * Body links are content references the author chose to include — high signal.
 * Nav links are site chrome (menus, footers, breadcrumbs) — low signal.
 * We surface them separately so the agent can focus on body links by default
 * and ignore the nav flood that swamps many pages.
 */

import type { SpideredPage } from "@dpopsuev/web-spider";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Remove keys whose value is an empty string, empty array, false, or
 * undefined. Keeps 0 and null intentionally — those are real values.
 */
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

// ---------------------------------------------------------------------------
// Per-format output builders
// ---------------------------------------------------------------------------

/**
 * Lean output — identity, metadata signals, outline, and body links.
 * No prose body. Use for triage: is this page relevant, and where should I
 * look next?
 *
 * Omitted vs. raw SpideredPage:
 *   - domain (derivable from url)
 *   - readingTimeMinutes (wordCount / 200, never actionable)
 *   - fetchedAt (internal timing, not content)
 *   - lang (almost always "en", rarely acted on)
 *   - chunks / markdown (the whole point of lean is to skip them)
 *   - nav links (surfaced as navLinksCount instead of flooding bodyLinks)
 *   - all empty strings and empty arrays
 */
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

/**
 * Markdown output — prose body plus the metadata fields an agent might act on.
 *
 * Omitted vs. raw SpideredPage:
 *   - domain (derivable from url)
 *   - readingTimeMinutes (wordCount / 200, never actionable)
 *   - headings (already present as ## lines inside markdown — would be duplicate)
 *   - links (not needed when reading prose; use format=links if you need them)
 *   - chunks (internal RAG structure; markdown is the readable form)
 *   - fetchedAt, lang
 *   - all empty strings and empty arrays
 */
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

/**
 * Links output — body links only, nav link count for awareness.
 * Use for graph traversal: which pages should I visit next?
 */
export function linksOutput(page: SpideredPage): Record<string, unknown> {
	return omitEmpty({
		url: page.url,
		title: page.title,
		bodyLinks: bodyLinks(page),
		navLinksCount: navLinksCount(page) || undefined,
	});
}

/**
 * A single highlights hit — the full chunk text only.
 * snippet is omitted: it is always a substring of text, so including both
 * repeats content and wastes tokens.
 */
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
