/**
 * YouTube oEmbed strategy — the flagship example of extending Web Spider to
 * a JS-heavy SPA (youtube.com's watch page is a client-rendered app shell;
 * a plain fetch()+Readability pass sees none of the real title/author/
 * description, only whatever the app shell ships server-side) *without*
 * reaching for a headless browser at all.
 *
 * Verified real and stable this session: youtube.com/oembed is YouTube's
 * own documented, unauthenticated, no-API-key oEmbed endpoint (the same
 * mechanism Twitter/X, Reddit, Vimeo, and every other oEmbed provider
 * exposes). A real request against a known-stable video
 * (`https://www.youtube.com/oembed?url=<watch-url>&format=json`) returns
 * `title`, `author_name`, `author_url`, `thumbnail_url`, and `html` (an
 * embeddable iframe snippet) as clean JSON — no scraping, no rate-limit
 * surprises, no browser.
 *
 * This is deliberately modest: oEmbed does not expose a video's
 * description, transcript, or comments (YouTube has no public,
 * unauthenticated endpoint for those) — those would need either the
 * (quota-limited, API-key-requiring) YouTube Data API or genuine headless
 * rendering (`enhanced: true` / PlaywrightHttpClient), which remain the
 * right tool for that deeper case. This strategy solves the part that has
 * a real, stable, keyless API: knowing what a video actually is without
 * paying for a browser to find out.
 */
import type { IHttpClient } from "../ports.js";
import type { ContentSourceStrategy } from "./content-source.js";
export interface YouTubeProbeOptions {
    /** ms before aborting the oEmbed request (default 10 000). */
    timeoutMs?: number;
    userAgent?: string;
}
export interface YouTubeOembedResult {
    videoId: string;
    title: string;
    authorName: string;
    authorUrl: string;
    thumbnailUrl: string;
}
/**
 * Extracts an 11-character YouTube video id from watch/shorts/youtu.be/
 * embed URL shapes. Returns null for a channel page, playlist, or anything
 * else that isn't a single-video URL — those aren't this strategy's shape.
 */
export declare function parseYouTubeVideoId(url: string): string | null;
/**
 * Queries YouTube's real oEmbed endpoint for a video's public metadata.
 * Returns null (never throws) for anything that isn't a genuine hit —
 * not a video URL, private/deleted video (oEmbed 404s), or network error.
 */
export declare function queryYouTubeOembed(url: string, httpClient: IHttpClient, options?: YouTubeProbeOptions): Promise<YouTubeOembedResult | null>;
/**
 * ContentSourceStrategy for youtube.com/youtu.be video URLs — see this
 * module's own doc comment for what it does and does not cover. Pass an
 * instance via `SpiderOptions.contentSources`, or register it under a name
 * via ./registry.ts.
 */
export declare function youtubeContentSource(options?: YouTubeProbeOptions): ContentSourceStrategy;
//# sourceMappingURL=youtube.d.ts.map