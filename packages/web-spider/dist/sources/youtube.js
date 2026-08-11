const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
/**
 * Extracts an 11-character YouTube video id from watch/shorts/youtu.be/
 * embed URL shapes. Returns null for a channel page, playlist, or anything
 * else that isn't a single-video URL — those aren't this strategy's shape.
 */
export function parseYouTubeVideoId(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
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
    if (host !== "youtube.com" && host !== "music.youtube.com")
        return null;
    const watchId = parsed.searchParams.get("v");
    if (watchId && idPattern.test(watchId))
        return watchId;
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
export async function queryYouTubeOembed(url, httpClient, options = {}) {
    const videoId = parseYouTubeVideoId(url);
    if (!videoId)
        return null;
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
        if (!res.ok)
            return null;
        const body = (await res.text()).trim();
        if (!body)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            return null;
        }
        if (!parsed.title)
            return null;
        return {
            videoId,
            title: parsed.title,
            authorName: parsed.author_name ?? "",
            authorUrl: parsed.author_url ?? "",
            thumbnailUrl: parsed.thumbnail_url ?? "",
        };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function toMarkdown(result, watchUrl) {
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
export function youtubeContentSource(options = {}) {
    return {
        name: "youtube",
        matches(url) {
            return parseYouTubeVideoId(url) !== null;
        },
        async fetch(req) {
            const result = await queryYouTubeOembed(req.url, req.httpClient, { timeoutMs: req.timeoutMs, userAgent: req.userAgent, ...options });
            if (!result)
                return null;
            const watchUrl = `https://www.youtube.com/watch?v=${result.videoId}`;
            return { url: watchUrl, contentType: "text/markdown; charset=utf-8", text: toMarkdown(result, watchUrl), title: result.title };
        },
    };
}
//# sourceMappingURL=youtube.js.map