/**
 * .md URL-suffix discovery strategy — for a documentation-shaped URL, try
 * fetching a `.md` variant of the exact same page before falling back to
 * fetch+Readability on the original HTML.
 *
 * Verified real and working this session against docs.aws.amazon.com:
 * .../AmazonS3/latest/userguide/Welcome.html has a genuine sibling at
 * .../AmazonS3/latest/userguide/Welcome.md returning 200 text/markdown.
 * An extensionless path (.../Welcome) 301-redirects to the .html version,
 * confirming .html is the real canonical extension to substitute from.
 * Both Coveo's and Algolia's own documentation sites independently mention
 * the identical "append .md to this page's URL" convention, suggesting it
 * is spreading beyond AWS.
 *
 * Unlike llms.txt (a site-wide index probed at the origin), this strategy
 * operates on the *specific* URL requested — it targets the same page, not
 * a different resource.
 */
import type { IHttpClient } from "./ports.js";
export interface ProbeMarkdownVariantOptions {
    /** ms before aborting the probe request (default 10 000). */
    timeoutMs?: number;
    userAgent?: string;
}
export interface MarkdownVariantProbeResult {
    /** The .md URL that was actually fetched. */
    url: string;
    content: string;
    /** Raw Content-Type header from the response, if any. */
    contentType: string | null;
}
/**
 * Derives the .md sibling URL for a documentation-shaped page, or null when
 * no sensible variant applies (already .md, or has some other extension
 * this convention doesn't cover, e.g. .pdf/.json).
 */
export declare function deriveMarkdownVariantUrl(url: string): string | null;
/**
 * Probes the .md variant of a specific URL. Returns null (never throws) for
 * anything that isn't a clean text-based 200 -- including the case where
 * deriveMarkdownVariantUrl finds no sensible variant to try at all.
 */
export declare function probeMarkdownVariant(url: string, httpClient: IHttpClient, options?: ProbeMarkdownVariantOptions): Promise<MarkdownVariantProbeResult | null>;
//# sourceMappingURL=markdown-suffix.d.ts.map