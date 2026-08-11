/**
 * llms.txt discovery strategy — the cheapest, most general query strategy:
 * one HTTP GET at a site's origin, no auth, no per-platform detection logic.
 *
 * llms.txt is an emerging convention (proposed 2024 by Jeremy Howard) where a
 * site publishes a structured Markdown content index at its root. Verified
 * real and high-value this session: AWS's docs.aws.amazon.com/llms.txt
 * indexes hundreds of service doc guides; a farmed directory
 * (github.com/thedaviddias/llms-txt-hub) lists 600+ developer-tools and
 * infrastructure-cloud adopters including Anthropic, Cloudflare, Docker,
 * Vercel, Supabase, Netlify, and Linear.
 *
 * Real-world adoption is genuinely mixed (an Ahrefs study of 137K sites found
 * only ~28% publish one at all), so this is deliberately a cheap probe that
 * fails closed to "not found" rather than an assumption baked into the
 * default fetch path.
 */
import type { IHttpClient } from "../ports.js";
import type { ContentSourceStrategy } from "./content-source.js";
export interface ProbeLlmsTxtOptions {
    /** ms before aborting each probe request (default 10 000). */
    timeoutMs?: number;
    userAgent?: string;
    /**
     * Also probe /llms-full.txt (full content embedded, not just an index of
     * links) if /llms.txt itself is not found. Default: false — llms.txt
     * alone is the common case and keeps this a single request.
     */
    includeFullVariant?: boolean;
}
export type LlmsTxtVariant = "llms.txt" | "llms-full.txt";
export interface LlmsTxtProbeResult {
    /** The llms.txt (or llms-full.txt) URL that was actually fetched — not the URL originally passed in. */
    url: string;
    variant: LlmsTxtVariant;
    content: string;
    /** Raw Content-Type header from the response, if any. */
    contentType: string | null;
}
/**
 * Probes a target URL's origin for a real llms.txt. Returns null (never
 * throws for a missing/broken llms.txt) so callers can cheaply fall back to
 * their normal fetch path.
 *
 * Guards against a real false-positive risk: many SPAs return 200 text/html
 * (their app shell) for any unmatched path rather than a real 404 -- a
 * genuine llms.txt is always text-based, so an HTML content-type is treated
 * as "not found," not a hit.
 */
export declare function probeLlmsTxt(targetUrl: string, httpClient: IHttpClient, options?: ProbeLlmsTxtOptions): Promise<LlmsTxtProbeResult | null>;
/**
 * ContentSourceStrategy adapter around {@link probeLlmsTxt} — the extension-
 * point-shaped form of the same logic `spider()`'s legacy `preferLlmsTxt`
 * flag uses internally. Unlike a platform-specific strategy (GitHub,
 * MediaWiki), `matches()` accepts any http(s) URL — llms.txt is a site-wide
 * convention, not a URL-shape signal — so every real cost lives in `fetch()`,
 * which still fails closed (returns null) on a genuine miss.
 */
export declare function llmsTxtContentSource(options?: ProbeLlmsTxtOptions): ContentSourceStrategy;
//# sourceMappingURL=llms-txt.d.ts.map