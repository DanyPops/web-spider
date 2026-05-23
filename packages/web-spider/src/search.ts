import MiniSearch from "minisearch";
import type { SpideredPage } from "./types.js";

/** A single ranked match from fuzzySearch. */
export interface SearchHit {
	/** URL of the page the match came from. */
	url: string;
	/**
	 * Stable chunk ID ("url#chunk-N") when the match is in body text.
	 * Empty string when the match is in page metadata (title, description,
	 * headings).
	 */
	chunkId: string;
	/** Nearest heading for the matched chunk, or the matched field name for
	 *  metadata hits (e.g. "title", "description"). */
	heading: string;
	/** Normalised score 0–1. Higher is a better match. */
	score: number;
	/** Short context window around the best match, ≤ 2×snippetRadius chars.
	 *  Prefixed/suffixed with "…" when truncated. */
	snippet: string;
}

export interface FuzzySearchOptions {
	/** Maximum hits to return (default 10). */
	topN?: number;
	/**
	 * Characters of context on each side of the match in the snippet
	 * (default 100). Keep low to save tokens; raise when you need more context.
	 */
	snippetRadius?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SearchDoc {
	/** Unique stable ID used by MiniSearch — chunk id or synthetic meta id. */
	id: string;
	url: string;
	/** Nearest heading or metadata field name ("title", "description", "h2", …). */
	heading: string;
	/** The text that was indexed and will be searched. */
	text: string;
	/** Same as id for chunks; empty string for metadata docs. */
	chunkId: string;
}

// ---------------------------------------------------------------------------
// Snippet builder — kept from v1, MiniSearch doesn't generate snippets.
// ---------------------------------------------------------------------------

/**
 * Build a short snippet around the best match position.
 * Falls back to the start of the text when no match is found.
 */
function buildSnippet(text: string, fullQuery: string, queryTokens: string[], radius: number): string {
	const lower = text.toLowerCase();

	let pos = lower.indexOf(fullQuery);
	if (pos === -1) {
		for (const qt of queryTokens) {
			const p = lower.indexOf(qt);
			if (p !== -1) {
				pos = p;
				break;
			}
		}
	}
	if (pos === -1) pos = 0;

	const start = Math.max(0, pos - radius);
	const end = Math.min(text.length, pos + Math.max(fullQuery.length, queryTokens[0]?.length ?? 1) + radius);
	const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
	return (start > 0 ? "…" : "") + raw + (end < text.length ? "…" : "");
}

/** Tokenise and lower-case a string — used only for snippet generation. */
function tokenise(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[\s\-_.,;:!?()[\]{}"'`/\\]+/)
		.filter((t) => t.length > 1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full-text search across a set of already-spidered pages using MiniSearch
 * (BM25F ranking, fuzzy edit-distance, prefix search, heading field boost ×2).
 *
 * Searches both body chunks and page metadata (title, description, headings).
 * Returns results ranked by score descending, normalised to 0–1.
 *
 * Designed for agent use: call after fetching pages to locate a specific
 * fact, term, or section without dumping all content into context.
 *
 * @example
 * const hits = searchPages(pages, "cost optimization selectors", { topN: 5 })
 * // hits[0].snippet → "…LLM extraction vs Selectors…"
 */
export function searchPages(pages: SpideredPage[], query: string, opts: FuzzySearchOptions = {}): SearchHit[] {
	const { topN = 10, snippetRadius = 100 } = opts;

	if (!query.trim()) return [];

	// Build a flat document list — one entry per chunk, one per metadata field.
	const docs: SearchDoc[] = [];

	for (const page of pages) {
		// Metadata documents
		const metaDocs: Array<{ id: string; heading: string; text: string }> = [
			{ id: `${page.url}#meta-title`, heading: "title", text: page.title },
			...(page.description
				? [{ id: `${page.url}#meta-description`, heading: "description", text: page.description }]
				: []),
			...page.headings.map((h, i) => ({
				id: `${page.url}#meta-h${i}`,
				heading: `h${h.level}`,
				text: h.text,
			})),
		];
		for (const m of metaDocs) {
			docs.push({ id: m.id, url: page.url, heading: m.heading, text: m.text, chunkId: "" });
		}

		// Chunk documents
		for (const c of page.chunks) {
			docs.push({ id: c.id, url: page.url, heading: c.heading, text: c.text, chunkId: c.id });
		}
	}

	if (docs.length === 0) return [];

	const ms = new MiniSearch<SearchDoc>({
		fields: ["text", "heading"],
		storeFields: ["url", "heading", "chunkId", "text"],
		searchOptions: {
			// BM25F: headings are 2× more important than body text.
			boost: { heading: 2 },
			// Edit-distance fuzzy — 0.2 × term length, rounded (e.g. ≤1 for 5-char terms).
			fuzzy: 0.2,
			// Prefix match: "automat" finds "automation", "automated".
			prefix: true,
		},
	});

	ms.addAll(docs);

	const results = ms.search(query);
	if (results.length === 0) return [];

	// Normalise raw BM25 scores to 0–1 by dividing by the top score.
	// This preserves relative ranking while keeping values agent-friendly.
	const maxRaw = results[0].score;

	const fullQuery = query.trim().toLowerCase();
	const queryTokens = tokenise(query);

	return results.slice(0, topN).map((r) => ({
		url: String(r["url"]),
		chunkId: String(r["chunkId"]),
		heading: String(r["heading"]),
		score: Math.round(Math.min(r.score / maxRaw, 1) * 100) / 100,
		snippet: buildSnippet(String(r["text"]), fullQuery, queryTokens, snippetRadius),
	}));
}

/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking. */
export const fuzzySearch = searchPages
