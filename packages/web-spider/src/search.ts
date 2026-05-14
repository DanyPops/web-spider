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
// Internal scoring helpers
// ---------------------------------------------------------------------------

/** Tokenise and lower-case a string into searchable words. */
function tokenise(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[\s\-_.,;:!?()[\]{}"'`/\\]+/)
		.filter((t) => t.length > 1);
}

/**
 * Score `text` against `queryTokens` and the raw `fullQuery`.
 *
 * Scoring tiers (additive, capped at 1.0):
 *  1. Exact full-query substring → 0.60 bonus
 *  2. Per-token: exact word → +0.30/n, prefix match → +0.15/n,
 *     substring match → +0.08/n  (n = number of query tokens)
 *
 * This keeps short single-word queries useful while rewarding precise
 * multi-word matches more than bags of partial hits.
 */
function scoreText(text: string, queryTokens: string[], fullQuery: string): number {
	if (!text) return 0;
	const lower = text.toLowerCase();

	let score = 0;

	// Exact full-query match is the strongest signal
	if (lower.includes(fullQuery)) score += 0.6;

	// Per-token scoring
	const perToken = 0.4 / Math.max(queryTokens.length, 1);
	const words = tokenise(text);

	for (const qt of queryTokens) {
		if (lower.includes(qt)) {
			// Check if it appears as a whole word vs. a substring
			const asWord = words.some((w) => w === qt);
			const asPrefix = !asWord && words.some((w) => w.startsWith(qt));
			score += asWord ? perToken : asPrefix ? perToken * 0.5 : perToken * 0.2;
		}
	}

	return Math.min(score, 1);
}

/**
 * Build a short snippet around the best match position.
 * Falls back to the start of the text when no match is found.
 */
function buildSnippet(text: string, fullQuery: string, queryTokens: string[], radius: number): string {
	const lower = text.toLowerCase();

	// Try exact full-query first, then first matching token
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fuzzy-search across a set of already-spidered pages.
 *
 * Searches both body chunks and page metadata (title, description, headings).
 * Returns results ranked by score descending, deduplicated per chunk/field.
 *
 * Designed for agent use: call after fetching pages to locate a specific
 * fact, term, or section without dumping all content into context.
 *
 * @example
 * const hits = fuzzySearch(pages, "cost optimization selectors", { topN: 5 })
 * // hits[0].snippet → "…LLM extraction vs Selectors…"
 */
export function fuzzySearch(pages: SpideredPage[], query: string, opts: FuzzySearchOptions = {}): SearchHit[] {
	const { topN = 10, snippetRadius = 100 } = opts;

	if (!query.trim()) return [];

	const fullQuery = query.trim().toLowerCase();
	const queryTokens = tokenise(query);

	const hits: SearchHit[] = [];

	for (const page of pages) {
		// --- metadata fields ---
		const metaTargets: Array<{ field: string; text: string }> = [
			{ field: "title", text: page.title },
			{ field: "description", text: page.description },
			...page.headings.map((h) => ({ field: `h${h.level}`, text: h.text })),
		];

		for (const { field, text } of metaTargets) {
			const score = scoreText(text, queryTokens, fullQuery);
			if (score > 0) {
				hits.push({
					url: page.url,
					chunkId: "",
					heading: field,
					score,
					snippet: buildSnippet(text, fullQuery, queryTokens, snippetRadius),
				});
			}
		}

		// --- body chunks ---
		for (const c of page.chunks) {
			const score = scoreText(c.text, queryTokens, fullQuery);
			if (score > 0) {
				hits.push({
					url: page.url,
					chunkId: c.id,
					heading: c.heading,
					score,
					snippet: buildSnippet(c.text, fullQuery, queryTokens, snippetRadius),
				});
			}
		}
	}

	return hits
		.sort((a, b) => b.score - a.score)
		.slice(0, topN)
		.map((h) => ({ ...h, score: Math.round(h.score * 100) / 100 }));
}
