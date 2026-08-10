/**
 * URL "Text Fragment" (a.k.a. Scroll-To-Text-Fragment) citation links --
 * https://wicg.github.io/scroll-to-text-fragment/. A real, standards-based
 * deep link a supporting browser (Chrome/Edge/Safari/Firefox) navigates to
 * and automatically scrolls to + highlights the exact quoted text, on any
 * page we don't control and that has no anchor IDs. Distinct from an
 * internal `chunkId` (e.g. "url#chunk-4"), which only means something
 * inside web-spider's own cache -- a citationUrl is copy-pasteable and
 * works standalone in any real browser tab.
 *
 * Kept as its own module (not folded into search.ts's ranking logic) --
 * this is a pure presentation/citation concern with its own single
 * responsibility, and search.ts's callers may not always want it.
 */
/**
 * Builds a Text Fragment citation URL for `snippetText` as found on `url`.
 * Returns undefined when the text is empty/whitespace-only -- the spec
 * requires a non-empty, word-bounded match, so there is nothing safe to
 * encode (falling back to chunkId-only is the caller's job).
 *
 * A quote longer than {@link RANGE_THRESHOLD_WORDS} words is linked as a
 * `textStart,textEnd` range using only its first/last {@link EDGE_WORDS}
 * words -- a real text-fragment range (matches everything in between,
 * even across block-level elements per spec) that keeps the URL bounded
 * instead of percent-encoding an entire paragraph.
 */
export declare function buildTextFragmentUrl(url: string, snippetText: string): string | undefined;
//# sourceMappingURL=citation.d.ts.map