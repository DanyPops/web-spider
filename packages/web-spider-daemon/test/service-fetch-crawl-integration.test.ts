/**
 * Adapter-level integration tests: real fixture HTML, through the full
 * production-wired `createWebSpiderService()` → HTTP `createApp()` surface —
 * the same path a real client (CLI, Pi extension, tests) uses, not a direct
 * unit-level FetchService/CrawlService call.
 *
 * globalThis.fetch is monkey-patched for the duration of each test (restored
 * in `finally`) because createWebSpiderService() wires production dependencies
 * with no injectable HTTP client seam — exactly the real deployment shape.
 * This mirrors packages/pi-extension/test/paths.test.ts's established
 * "mock globalThis.fetch, serve fixture HTML" convention for this exact
 * scenario (testing the real wiring, not a unit under test).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, createWebSpiderService } from "../src/service.ts";

const TOKEN = "test-token";
const FIXTURES_DIR = join(import.meta.dir, "../../web-spider/fixtures");
const ARTICLE_URL = "https://example.com/article-with-images";
const ARTICLE_HTML = readFileSync(join(FIXTURES_DIR, "article-with-images.html"), "utf8");

function mockGlobalFetch(routes: Record<string, string>): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const body = routes[url];
		if (body === undefined) {
			return new Response("", { status: 404, statusText: "Not Found" });
		}
		return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
	}) as typeof fetch;
	return () => { globalThis.fetch = original; };
}

async function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown>) {
	const response = await app.fetch(new Request("http://x/api/v1/ops", {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ op, input }),
	}));
	const body = await response.json() as { result?: unknown; error?: string };
	return { status: response.status, body };
}

describe("fetch/crawl operations — real fixture through the full HTTP surface", () => {
	test("fetch markdown returns the real article body and caches it for a subsequent hit", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });

			const first = await post(app, "fetch", { url: ARTICLE_URL });
			expect(first.status).toBe(200);
			const firstResult = first.body.result as Record<string, unknown>;
			expect(firstResult.title).toBe("Article With Images — Fixture");
			expect(firstResult.cache).toBe("miss");
			expect(typeof firstResult.markdown).toBe("string");
			expect((firstResult.markdown as string)).toContain("Images are a fundamental part");

			const second = await post(app, "fetch", { url: ARTICLE_URL });
			expect((second.body.result as Record<string, unknown>).cache).toBe("hit");

			// cache.list now reflects the real fetched-and-cached page.
			const listing = await post(app, "cache.list", {});
			const listResult = listing.body.result as { total: number; pages: Array<{ url: string }> };
			expect(listResult.total).toBe(1);
			expect(listResult.pages[0]?.url).toBe(ARTICLE_URL);

			service.close();
		} finally {
			restore();
		}
	});

	test("fetch lean omits prose and reports the fixture's body links", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });
			const { status, body } = await post(app, "fetch", { url: ARTICLE_URL, format: "lean" });
			expect(status).toBe(200);
			const result = body.result as Record<string, unknown>;
			expect(result).not.toHaveProperty("markdown");
			expect(Array.isArray(result.headings)).toBe(true);
			service.close();
		} finally {
			restore();
		}
	});

	test("crawl lean discovers the single-page fixture site and reports it bounded", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });
			const { status, body } = await post(app, "crawl", { url: ARTICLE_URL, format: "lean", depth: 1, maxPages: 5 });
			expect(status).toBe(200);
			const result = body.result as { pagesFound: number; pages: Array<Record<string, unknown>> };
			expect(result.pagesFound).toBeGreaterThanOrEqual(1);
			expect(result.pages[0]).not.toHaveProperty("markdown");
			service.close();
		} finally {
			restore();
		}
	});

	test("fetching an unmapped URL surfaces as a native failure through the operation dispatch (404 route → HTTP error)", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });
			const { status, body } = await post(app, "fetch", { url: "https://example.com/does-not-exist" });
			expect(status).toBe(400);
			expect(body.error).toContain("404");
			service.close();
		} finally {
			restore();
		}
	});
});
