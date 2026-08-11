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
import type { ContentSourceRequest, ContentSourceResult, ContentSourceStrategy } from "./content-source.js";

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

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";

interface OembedResponse {
	title?: string;
	author_name?: string;
	author_url?: string;
	thumbnail_url?: string;
}

/**
 * Extracts an 11-character YouTube video id from watch/shorts/youtu.be/
 * embed URL shapes. Returns null for a channel page, playlist, or anything
 * else that isn't a single-video URL — those aren't this strategy's shape.
 */
export function parseYouTubeVideoId(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = parsed.hostname
		.toLowerCase()
		.replace(/^www\./, "")
		.replace(/^m\./, "");
	const idPattern = /^[A-Za-z0-9_-]{11}$/;

	if (host === "youtu.be") {
		const id = parsed.pathname.split("/").filter(Boolean)[0];
		return id && idPattern.test(id) ? id : null;
	}

	if (host !== "youtube.com" && host !== "music.youtube.com") return null;

	const watchId = parsed.searchParams.get("v");
	if (watchId && idPattern.test(watchId)) return watchId;

	const segments = parsed.pathname.split("/").filter(Boolean);
	if ((segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live") && segments[1] && idPattern.test(segments[1])) {
		return segments[1];
	}
	return null;
}

/**
 * Queries YouTube's real oEmbed endpoint for a video's public metadata.
 * Returns null (never throws) for anything that isn't a genuine hit —
 * not a video URL, private/deleted video (oEmbed 404s), or network error.
 */
export async function queryYouTubeOembed(
	url: string,
	httpClient: IHttpClient,
	options: YouTubeProbeOptions = {},
): Promise<YouTubeOembedResult | null> {
	const videoId = parseYouTubeVideoId(url);
	if (!videoId) return null;

	const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
	const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const oembedUrl = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(watchUrl)}&format=json`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await httpClient.fetch({
			url: oembedUrl,
			signal: controller.signal,
			headers: { "User-Agent": userAgent, Accept: "application/json" },
		});
		if (!res.ok) return null;
		const body = (await res.text()).trim();
		if (!body) return null;
		let parsed: OembedResponse;
		try {
			parsed = JSON.parse(body) as OembedResponse;
		} catch {
			return null;
		}
		if (!parsed.title) return null;
		return {
			videoId,
			title: parsed.title,
			authorName: parsed.author_name ?? "",
			authorUrl: parsed.author_url ?? "",
			thumbnailUrl: parsed.thumbnail_url ?? "",
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function toMarkdown(result: YouTubeOembedResult, watchUrl: string): string {
	const lines = [
		`# ${result.title}`,
		"",
		result.authorName ? `- Channel: [${result.authorName}](${result.authorUrl || watchUrl})` : "",
		`- Watch: ${watchUrl}`,
		result.thumbnailUrl ? "" : "",
		result.thumbnailUrl ? `![${result.title}](${result.thumbnailUrl})` : "",
	].filter((line, index, all) => !(line === "" && all[index - 1] === ""));
	return lines.join("\n").trim();
}

/**
 * ContentSourceStrategy for youtube.com/youtu.be video URLs — see this
 * module's own doc comment for what it does and does not cover. Pass an
 * instance via `SpiderOptions.contentSources`, or register it under a name
 * via ./registry.ts.
 */
export function youtubeContentSource(options: YouTubeProbeOptions = {}): ContentSourceStrategy {
	return {
		name: "youtube",
		matches(url) {
			return parseYouTubeVideoId(url) !== null;
		},
		async fetch(req: ContentSourceRequest): Promise<ContentSourceResult | null> {
			const result = await queryYouTubeOembed(req.url, req.httpClient, { timeoutMs: req.timeoutMs, userAgent: req.userAgent, ...options });
			if (!result) return null;
			const watchUrl = `https://www.youtube.com/watch?v=${result.videoId}`;
			return { url: watchUrl, contentType: "text/markdown; charset=utf-8", text: toMarkdown(result, watchUrl), title: result.title };
		},
	};
}
