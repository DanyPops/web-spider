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
export declare function fuzzySearch(pages: SpideredPage[], query: string, opts?: FuzzySearchOptions): SearchHit[];
//# sourceMappingURL=search.d.ts.map