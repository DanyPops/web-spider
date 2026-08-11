/**
 * Unit tests for the YouTube oEmbed strategy (src/sources/youtube.ts) — no
 * real network, stub IHttpClient, matching the existing
 * mediawiki.test.ts/markdown-suffix.test.ts pattern.
 */
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { parseYouTubeVideoId, queryYouTubeOembed, youtubeContentSource } from "../src/sources/youtube.js";

function stubClient(handler: (url: string) => { ok: boolean; body: string }): IHttpClient {
	return {
		async fetch(req) {
			const { ok, body } = handler(req.url);
			return {
				ok,
				status: ok ? 200 : 404,
				statusText: ok ? "OK" : "Not Found",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
				text: async () => body,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
			};
		},
	};
}

describe("parseYouTubeVideoId", () => {
	it("extracts the id from a watch URL", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	});

	it("extracts the id from a youtu.be short link", () => {
		expect(parseYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	});

	it("extracts the id from a shorts URL", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	});

	it("extracts the id from an embed URL", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	});

	it("ignores extra query params", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s")).toBe("dQw4w9WgXcQ");
	});

	it("returns null for a channel page", () => {
		expect(parseYouTubeVideoId("https://www.youtube.com/@RickAstleyYT")).toBeNull();
	});

	it("returns null for a non-YouTube host", () => {
		expect(parseYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
	});

	it("returns null for an invalid URL", () => {
		expect(parseYouTubeVideoId("not-a-url")).toBeNull();
	});
});

describe("queryYouTubeOembed", () => {
	it("returns metadata on a real oEmbed hit", async () => {
		const httpClient = stubClient((url) => {
			expect(url).toContain("https://www.youtube.com/oembed?url=");
			expect(url).toContain("dQw4w9WgXcQ");
			return {
				ok: true,
				body: JSON.stringify({
					title: "Never Gonna Give You Up",
					author_name: "Rick Astley",
					author_url: "https://www.youtube.com/@RickAstleyYT",
					thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
				}),
			};
		});

		const result = await queryYouTubeOembed("https://www.youtube.com/watch?v=dQw4w9WgXcQ", httpClient);
		expect(result).toEqual({
			videoId: "dQw4w9WgXcQ",
			title: "Never Gonna Give You Up",
			authorName: "Rick Astley",
			authorUrl: "https://www.youtube.com/@RickAstleyYT",
			thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
		});
	});

	it("returns null for a non-YouTube URL without making a request", async () => {
		const httpClient = stubClient(() => ({ ok: true, body: "{}" }));
		expect(await queryYouTubeOembed("https://example.com/page", httpClient)).toBeNull();
	});

	it("returns null when oEmbed 404s (private/deleted video)", async () => {
		const httpClient = stubClient(() => ({ ok: false, body: "" }));
		expect(await queryYouTubeOembed("https://www.youtube.com/watch?v=dQw4w9WgXcQ", httpClient)).toBeNull();
	});
});

describe("youtubeContentSource", () => {
	it("matches() accepts a video URL and rejects a non-video URL", () => {
		const source = youtubeContentSource();
		expect(source.matches("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
		expect(source.matches("https://example.com")).toBe(false);
	});

	it("fetch() returns markdown built from oEmbed metadata, with the canonical watch URL", async () => {
		const httpClient = stubClient(() => ({
			ok: true,
			body: JSON.stringify({ title: "Test Video", author_name: "Test Channel", author_url: "https://www.youtube.com/@test" }),
		}));
		const source = youtubeContentSource();

		const result = await source.fetch({ url: "https://youtu.be/dQw4w9WgXcQ", httpClient, timeoutMs: 10_000, userAgent: "test" });

		expect(result?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result?.title).toBe("Test Video");
		expect(result?.text).toContain("# Test Video");
		expect(result?.text).toContain("Test Channel");
	});
});
