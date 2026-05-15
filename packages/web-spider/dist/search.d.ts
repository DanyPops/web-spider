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
export declare function searchPages(pages: SpideredPage[], query: string, opts?: FuzzySearchOptions): SearchHit[];
/** @deprecated Use {@link searchPages} — renamed in v0.4.0 to reflect BM25F ranking. */
export declare const fuzzySearch: typeof searchPages;
//# sourceMappingURL=search.d.ts.map