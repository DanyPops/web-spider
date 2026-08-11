/**
 * TDD tests for the ContentSourceStrategy extension point
 * (src/sources/content-source.ts) — the seam a new per-site adapter plugs
 * into via SpiderOptions.contentSources without editing spider() itself.
 * Mirrors test/content-extractor-strategy.test.ts's shape for the sibling
 * ContentExtractor Strategy.
 */
import { describe, expect, it, vi } from "vitest";
import type { ContentSourceStrategy, IHttpClient } from "../src/index.js";
import { spider } from "../src/index.js";

function stubHttpClient(): IHttpClient {
	return {
		fetch: vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => "text/html" },
			text: async () =>
				"<html><head><title>Fallback</title></head><body><p>Fallback content, long enough for Readability to treat as an article body.</p></body></html>",
			arrayBuffer: async () => new ArrayBuffer(0),
		})),
	};
}

describe("ContentSourceStrategy", () => {
	it("a matching custom strategy wins before any network fetch happens", async () => {
		const httpClient = stubHttpClient();
		const strategy: ContentSourceStrategy = {
			name: "my-custom-site",
			matches: (url) => url.includes("my-site.example"),
			fetch: vi.fn(async () => ({
				url: "https://my-site.example/article/1",
				contentType: "text/markdown; charset=utf-8",
				text: "# Custom Title\n\nReal content from a custom API, not the rendered page.",
				title: "Custom Title",
			})),
		};

		const page = await spider("https://my-site.example/article/1", { httpClient, contentSources: [strategy] });

		expect(page.viaStrategy).toBe("my-custom-site");
		expect(page.title).toBe("Custom Title");
		expect(page.markdown).toContain("Real content from a custom API");
		expect(httpClient.fetch).not.toHaveBeenCalled();
	});

	it("matches() is checked before fetch() — a non-matching strategy's fetch is never called", async () => {
		const httpClient = stubHttpClient();
		const fetchSpy = vi.fn();
		const strategy: ContentSourceStrategy = { name: "irrelevant", matches: () => false, fetch: fetchSpy };

		const page = await spider("https://example.com/page", { httpClient, contentSources: [strategy] });

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(page.viaStrategy).toBeUndefined();
		expect(httpClient.fetch).toHaveBeenCalled();
	});

	it("a matching strategy whose fetch() misses (returns null) falls through to the next one, then to a plain fetch", async () => {
		const httpClient = stubHttpClient();
		const missing: ContentSourceStrategy = { name: "misses", matches: () => true, fetch: async () => null };
		const hitting: ContentSourceStrategy = {
			name: "hits",
			matches: () => true,
			fetch: async (req) => ({ url: req.url, contentType: "text/markdown", text: "# Second strategy wins" }),
		};

		const page = await spider("https://example.com/page", { httpClient, contentSources: [missing, hitting] });

		expect(page.viaStrategy).toBe("hits");
		expect(page.markdown).toContain("Second strategy wins");
	});

	it("no matching strategy at all falls through to the normal fetch path unchanged", async () => {
		const httpClient = stubHttpClient();
		const page = await spider("https://example.com/page", { httpClient, contentSources: [] });

		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("Fallback");
	});

	it("a strategy resolving to a different resource URL (e.g. a site-wide index) reports that URL, not the requested one", async () => {
		const httpClient = stubHttpClient();
		const strategy: ContentSourceStrategy = {
			name: "site-index",
			matches: () => true,
			fetch: async () => ({ url: "https://example.com/llms.txt", contentType: "text/plain", text: "# Index\n\nSome content." }),
		};

		const page = await spider("https://example.com/page", { httpClient, contentSources: [strategy] });

		expect(page.url).toBe("https://example.com/llms.txt");
		expect(page.viaStrategy).toBe("site-index");
	});
});
