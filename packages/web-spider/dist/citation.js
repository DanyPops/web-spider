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
/** Word count on each edge of a long quote used to build a textStart,textEnd range instead of encoding the whole thing. */
const EDGE_WORDS = 6;
/** Quotes at or under this many words are linked as a single exact `text=` value; longer ones become a `textStart,textEnd` range. */
const RANGE_THRESHOLD_WORDS = EDGE_WORDS * 2;
/**
 * Percent-encodes one text-fragment value per the WICG spec's syntax rules:
 * https://wicg.github.io/scroll-to-text-fragment/#syntax
 * The literal `-` character must also be escaped beyond encodeURIComponent's
 * own default set, since an unescaped `-` would be ambiguous with the
 * `prefix-`/`-suffix` delimiter hyphen.
 */
function encodeTextFragmentValue(value) {
    return encodeURIComponent(value).replace(/-/g, "%2D");
}
/**
 * Strips buildSnippet()'s "…" truncation markers and collapses whitespace --
 * those markers are never present in the real page text and would prevent
 * the text fragment from matching anything at all.
 */
function stripSnippetTruncation(snippet) {
    return snippet.replace(/^…+/, "").replace(/…+$/, "").trim();
}
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
export function buildTextFragmentUrl(url, snippetText) {
    const text = stripSnippetTruncation(snippetText);
    if (!text)
        return undefined;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0)
        return undefined;
    const fragment = words.length <= RANGE_THRESHOLD_WORDS
        ? `text=${encodeTextFragmentValue(text)}`
        : `text=${encodeTextFragmentValue(words.slice(0, EDGE_WORDS).join(" "))},${encodeTextFragmentValue(words.slice(-EDGE_WORDS).join(" "))}`;
    const hashIndex = url.indexOf("#");
    if (hashIndex === -1)
        return `${url}#:~:${fragment}`;
    // A pre-existing element-id fragment is preserved as a fallback target: per
    // spec, if the text match isn't found the browser can fall back to scrolling
    // to the element-id fragment that precedes the directive.
    return `${url.slice(0, hashIndex)}#${url.slice(hashIndex + 1)}:~:${fragment}`;
}
//# sourceMappingURL=citation.js.map