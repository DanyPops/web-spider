/**
 * Content-Type classification — decides which parse strategy a fetched
 * response should go through, before any HTML-specific parsing (linkedom,
 * Readability) is attempted. Grounded in the real media-type landscape:
 * IANA's top-level types (application, audio, example, font, haptics,
 * image, message, model, multipart, text, video — see
 * https://www.iana.org/assignments/top-level-media-types) and RFC 6838
 * §4.2.8's "+suffix" convention, where a suffix like +json or +xml names
 * the underlying syntax regardless of the specific vendor/semantic type
 * (application/ld+json, application/geo+json, application/atom+xml, ...).
 *
 * Real-world scrapers already have to make exactly this decision — HTML is
 * "the crushing majority" of what's fetched, but JSON, XML/RSS/Atom feeds,
 * and plain text (increasingly llms.txt-style docs) all show up too, and
 * binary content (images, PDFs, archives) is never text to extract at all.
 */
export type ContentKind = "html" | "text" | "json" | "xml" | "unsupported";
/**
 * Classifies a Content-Type header value into a parse strategy.
 *
 * An absent or unparseable header defaults to "html" — the historical,
 * implicit behavior before this classification existed. Many servers omit
 * or misreport Content-Type; assuming HTML preserves today's behavior for
 * the overwhelmingly common case rather than newly rejecting requests that
 * used to work.
 */
export declare function classifyContentType(header: string | null | undefined): ContentKind;
//# sourceMappingURL=content-type.d.ts.map