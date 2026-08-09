import { describe, expect, it, vi } from "vitest";
import { type ContentExtractor, type IHttpClient, type SpideredPage, spider } from "../src/index.js";

function fixtureClient(): IHttpClient {
	return {
		fetch: vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/x-fixture" : null) },
			text: async () => "fixture body",
			arrayBuffer: async () => new TextEncoder().encode("fixture body").buffer as ArrayBuffer,
		})),
	};
}

function extractedPage(url: string, fetchedAt: string): SpideredPage {
	return {
		url,
		domain: "example.com",
		fetchedAt,
		title: "Injected extractor",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 2,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: [],
		markdown: "normalized fixture",
	};
}

describe("ContentExtractor Strategy", () => {
	it("selects an injected extractor before built-ins without a network or parser", async () => {
		const httpClient = fixtureClient();
		const extractor: ContentExtractor = {
			supports: vi.fn((resource) => resource.contentType === "application/x-fixture"),
			extract: vi.fn(async (resource, _options) => ({
				page: extractedPage(resource.url, resource.fetchedAt),
			})),
		};

		const page = await spider("https://example.com/custom.bin", {
			httpClient,
			contentExtractors: [extractor],
		});

		expect(page.title).toBe("Injected extractor");
		expect(page.markdown).toBe("normalized fixture");
		expect(extractor.supports).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://example.com/custom.bin",
				contentType: "application/x-fixture",
				text: "fixture body",
			}),
		);
		expect(extractor.extract).toHaveBeenCalledWith(
			expect.objectContaining({ text: "fixture body" }),
			expect.objectContaining({ view: "full", captureImages: false }),
		);
	});
});
