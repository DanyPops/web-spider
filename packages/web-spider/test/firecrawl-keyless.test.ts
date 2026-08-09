import { describe, expect, it, vi } from "vitest";
import type { ISearchEngine, SearchQuery, WebSearchResult } from "../src/ports.js";
import {
	defaultSearchEngine,
	FallbackSearchEngine,
	FirecrawlKeylessSearchEngine,
	firecrawlKeylessSearch,
	type SearchTransport,
} from "../src/web-search/index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

const CAPTURED_SUCCESS = {
	success: true,
	data: {
		web: [
			{
				url: "https://github.com/microsoft/tsyringe",
				title: "microsoft/tsyringe",
				description: "A lightweight dependency injection container for TypeScript.",
				position: 1,
			},
		],
	},
	creditsUsed: 2,
	id: "captured-job",
};

function fakeEngine(search: (req: SearchQuery) => Promise<WebSearchResult[]>): ISearchEngine {
	return { search };
}

describe("Firecrawl keyless ISearchEngine adapter", () => {
	it("normalizes a representative captured web result and sends no credentials", async () => {
		const transport: SearchTransport = vi.fn(async () => jsonResponse(CAPTURED_SUCCESS));
		const engine = new FirecrawlKeylessSearchEngine({ transport });

		await expect(engine.search({ query: "TypeScript dependency injection", numResults: 3, timeRange: "week" })).resolves.toEqual([
			{
				url: "https://github.com/microsoft/tsyringe",
				title: "microsoft/tsyringe",
				snippet: "A lightweight dependency injection container for TypeScript.",
			},
		]);
		const [endpoint, request] = vi.mocked(transport).mock.calls[0] as [string, RequestInit];
		expect(endpoint).toBe("https://api.firecrawl.dev/v2/search");
		expect(request).toMatchObject({ method: "POST", redirect: "error" });
		expect(new Headers(request.headers).has("authorization")).toBe(false);
		expect(JSON.parse(request.body as string)).toEqual({
			query: "TypeScript dependency injection",
			limit: 3,
			sources: ["web"],
			highlights: false,
			tbs: "qdr:w",
		});
	});

	it("maps site and news intent without enabling credit-expensive page scraping", async () => {
		const transport: SearchTransport = vi.fn(async () =>
			jsonResponse({
				success: true,
				data: { news: [{ url: "https://news.example/story", title: "Story", snippet: "Summary", date: "2026-08-09" }] },
			}),
		);
		const results = await firecrawlKeylessSearch("release", {
			transport,
			numResults: 5,
			topic: "news",
			timeRange: "week", // documented as unsupported for news, so it is intentionally omitted on the wire
			siteFilter: "news.example",
		});

		expect(results).toEqual([{ url: "https://news.example/story", title: "Story", snippet: "Summary", publishedAt: "2026-08-09" }]);
		const request = vi.mocked(transport).mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(request.body as string)).toEqual({
			query: "release",
			limit: 5,
			sources: ["news"],
			highlights: false,
			includeDomains: ["news.example"],
		});
	});

	it("returns a genuine empty result list", async () => {
		const transport: SearchTransport = async () => jsonResponse({ success: true, data: { web: [] } });
		await expect(firecrawlKeylessSearch("no matches", { transport })).resolves.toEqual([]);
	});

	it("rejects malformed JSON and malformed success payloads", async () => {
		const malformedJson: SearchTransport = async () => new Response("{broken", { status: 200 });
		const malformedPayload: SearchTransport = async () => jsonResponse({ success: true, data: {} });
		await expect(firecrawlKeylessSearch("query", { transport: malformedJson })).rejects.toThrow(/malformed JSON/i);
		await expect(firecrawlKeylessSearch("query", { transport: malformedPayload })).rejects.toThrow(/malformed.*payload/i);
	});

	it("rejects CAPTCHA/forbidden responses and rate limits, retaining bounded retry information", async () => {
		const captcha: SearchTransport = async () => new Response("<html>CAPTCHA</html>", { status: 403, statusText: "Forbidden" });
		const limited: SearchTransport = async () =>
			jsonResponse(
				{ success: false, error: "keyless free tier rate limit reached", retryAfter: 120 },
				{ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "120" } },
			);
		await expect(firecrawlKeylessSearch("query", { transport: captcha })).rejects.toThrow(/403 Forbidden/);
		await expect(firecrawlKeylessSearch("query", { transport: limited })).rejects.toThrow(/429.*retry after 120/i);
	});

	it("rejects redirects instead of following an untrusted POST target", async () => {
		const transport: SearchTransport = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
		);
		await expect(firecrawlKeylessSearch("query", { transport })).rejects.toThrow(/302/);
		expect(vi.mocked(transport).mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
	});

	it("turns an abort into a bounded timeout error", async () => {
		const transport: SearchTransport = async (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		await expect(firecrawlKeylessSearch("query", { transport, timeoutMs: 5 })).rejects.toThrow(/timed out after 5ms/i);
	});

	it("drops malformed and non-HTTP result entries instead of exposing unstable shapes", async () => {
		const transport: SearchTransport = async () =>
			jsonResponse({
				success: true,
				data: {
					web: [
						{ url: "javascript:alert(1)", title: "unsafe", description: "x" },
						{ url: "https://example.com/no-title", description: "x" },
						{ url: "https://example.com/good", title: " Good ", description: " Summary " },
					],
				},
			});
		await expect(firecrawlKeylessSearch("query", { transport })).resolves.toEqual([
			{ url: "https://example.com/good", title: "Good", snippet: "Summary" },
		]);
	});
});

describe("keyless fallback semantics", () => {
	it("provides no-key search through the injected last-resort Strategy", async () => {
		const keyless = fakeEngine(vi.fn(async () => [{ url: "https://example.com", title: "Found", snippet: "" }]));
		const engine = defaultSearchEngine({ env: {}, keylessEngine: keyless });
		await expect(engine.search({ query: "works without keys" })).resolves.toHaveLength(1);
	});

	it("preserves an actionable upstream error when the last resort returns empty", async () => {
		const upstreamError = new Error("paid provider credentials rejected");
		const chain = new FallbackSearchEngine([fakeEngine(async () => Promise.reject(upstreamError)), fakeEngine(async () => [])], {
			preserveEarlierError: true,
		});
		await expect(chain.search({ query: "query" })).rejects.toBe(upstreamError);
	});

	it("preserves an actionable upstream error when the last resort is blocked", async () => {
		const upstreamError = new Error("paid provider credentials rejected");
		const chain = new FallbackSearchEngine(
			[fakeEngine(async () => Promise.reject(upstreamError)), fakeEngine(async () => Promise.reject(new Error("keyless 429")))],
			{ preserveEarlierError: true },
		);
		await expect(chain.search({ query: "query" })).rejects.toBe(upstreamError);
	});

	it("still returns genuine empty when both engines completed successfully with no results", async () => {
		const chain = new FallbackSearchEngine([fakeEngine(async () => []), fakeEngine(async () => [])], { preserveEarlierError: true });
		await expect(chain.search({ query: "query" })).resolves.toEqual([]);
	});
});
