/**
 * Adapter-level integration tests: real fixture HTML, through the full
 * production-wired `createWebSpiderService()` → HTTP `createApp()` surface —
 * the same path a real client (CLI, Pi extension, tests) uses, not a direct
 * unit-level FetchService/CrawlService call.
 *
 * globalThis.fetch is monkey-patched for the duration of each test (restored
 * in `finally`) because createWebSpiderService() wires production dependencies
 * with no injectable HTTP client seam — exactly the real deployment shape.
 * This mirrors packages/pi-web-spider/test/paths.test.ts's established
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
	return () => {
		globalThis.fetch = original;
	};
}

async function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown>) {
	const response = await app.fetch(
		new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op, input }),
		}),
	);
	const body = (await response.json()) as { result?: unknown; error?: string };
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
			expect(firstResult.markdown as string).toContain("Images are a fundamental part");

			const second = await post(app, "fetch", { url: ARTICLE_URL });
			expect((second.body.result as Record<string, unknown>).cache).toBe("hit");

			// cache.list now reflects the real fetched-and-cached page.
			const listing = await post(app, "cache.list", {});
			const listResult = listing.body.result as { total: number; pages: Array<{ url: string }> };
			expect(listResult.total).toBe(1);
			expect(listResult.pages[0]?.url).toBe(ARTICLE_URL);

			await service.close();
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
			await service.close();
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
			await service.close();
		} finally {
			restore();
		}
	});

	test("crawl discoverOnly/crawlUrls/maxTotalChars/deadlineMs round-trip through the real /api/v1/ops HTTP boundary", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });

			const discover = await post(app, "crawl", { url: ARTICLE_URL, format: "lean", depth: 1, maxPages: 5, discoverOnly: true });
			expect(discover.status).toBe(200);
			const discoverResult = discover.body.result as { pages: Array<Record<string, unknown>>; nextAction: string };
			expect(discoverResult.pages.length).toBeGreaterThanOrEqual(1);
			expect(typeof discoverResult.pages[0]?.pageType).toBe("string");
			expect(typeof discoverResult.nextAction).toBe("string");

			const selective = await post(app, "crawl", { url: ARTICLE_URL, format: "lean", crawlUrls: [ARTICLE_URL] });
			expect(selective.status).toBe(200);
			const selectiveResult = selective.body.result as { pages: Array<{ url: string }> };
			expect(selectiveResult.pages.map((p) => p.url)).toEqual([ARTICLE_URL]);

			const budgeted = await post(app, "crawl", { url: ARTICLE_URL, format: "lean", depth: 1, maxTotalChars: 1, deadlineMs: 60_000 });
			expect(budgeted.status).toBe(200);
			expect((budgeted.body.result as { nextAction: string }).nextAction).toBe("max-total-chars");

			await service.close();
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
			await service.close();
		} finally {
			restore();
		}
	});
});

describe("fetch/crawl operations — the same real fixture, through the real Vehicle wire protocol", () => {
	async function invoke(app: { fetch(request: Request): Promise<Response> }, name: string, input: Record<string, unknown>) {
		const response = await app.fetch(
			new Request("http://x/vehicle/invoke", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
			}),
		);
		return {
			status: response.status,
			body: (await response.json()) as {
				output?: Record<string, unknown>;
				error?: {
					code: string;
					category: string;
					message: string;
					retryable: boolean;
					details?: Record<string, unknown>;
				};
			},
		};
	}

	test("fetch.markdown returns the same real article body /api/v1/ops already proved, and caches it", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });

			const first = await invoke(app, "fetch", { url: ARTICLE_URL });
			expect(first.status).toBe(200);
			expect(first.body.output?.title).toBe("Article With Images — Fixture");
			expect(first.body.output?.cache).toBe("miss");

			const second = await invoke(app, "fetch", { url: ARTICLE_URL });
			expect(second.body.output?.cache).toBe("hit");

			await service.close();
		} finally {
			restore();
		}
	});

	test("crawl discovers the single-page fixture site through /vehicle/invoke, matching the /api/v1/ops shape", async () => {
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });
			const { status, body } = await invoke(app, "crawl", { url: ARTICLE_URL, format: "lean", depth: 1, maxPages: 5 });
			expect(status).toBe(200);
			expect((body.output?.pagesFound as number) ?? 0).toBeGreaterThanOrEqual(1);
			await service.close();
		} finally {
			restore();
		}
	});

	test("crawl discoverOnly/crawlUrls/maxTotalChars/deadlineMs actually reach CrawlService through /vehicle/invoke (the real handlers/fetch.ts registration pi-web-spider calls)", async () => {
		const OTHER_URL = "https://example.com/another-fixture-page";
		const restore = mockGlobalFetch({ [ARTICLE_URL]: ARTICLE_HTML, [OTHER_URL]: ARTICLE_HTML });
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });

			const discover = await invoke(app, "crawl", { url: ARTICLE_URL, format: "lean", depth: 1, maxPages: 5, discoverOnly: true });
			expect(discover.status).toBe(200);
			const discoverPages = discover.body.output?.pages as Array<Record<string, unknown>>;
			expect(discoverPages.length).toBeGreaterThanOrEqual(1);
			expect(typeof discoverPages[0]?.pageType).toBe("string");

			// crawlUrls targets a URL *different* from `url` -- if crawlUrls were
			// silently dropped, this would fall back to a plain depth-0 fetch of
			// `url` (ARTICLE_URL) instead, a genuinely distinguishing assertion.
			const selective = await invoke(app, "crawl", { url: ARTICLE_URL, format: "lean", crawlUrls: [OTHER_URL] });
			expect(selective.status).toBe(200);
			const selectivePages = selective.body.output?.pages as Array<{ url: string }>;
			expect(selectivePages.map((p) => p.url)).toEqual([OTHER_URL]);

			await service.close();
		} finally {
			restore();
		}
	});

	test("fetch transport diagnostics survive the Vehicle wire without exposing the native cause", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			const cause = Object.assign(new Error("connect ECONNREFUSED https://user:password@example.test?token=top-secret"), {
				code: "ECONNREFUSED",
			});
			throw new TypeError("fetch failed", { cause });
		}) as unknown as typeof fetch;
		try {
			const service = createWebSpiderService(":memory:");
			const app = createApp({ service, token: TOKEN });
			const { status, body } = await invoke(app, "fetch", { url: "https://example.test/private?api_key=top-secret" });

			expect(status).toBe(503);
			expect(body.error).toMatchObject({
				code: "fetch-transport-failed",
				category: "unavailable",
				retryable: true,
				details: { kind: "connection", diagnostic: "Remote endpoint unavailable" },
			});
			const serialized = JSON.stringify(body.error);
			expect(serialized).not.toContain("top-secret");
			expect(serialized).not.toContain("password");
			await service.close();
		} finally {
			globalThis.fetch = original;
		}
	});

	test("fetch with a missing url fails with a real Vehicle validation error, not a crash", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		const { status, body } = await invoke(app, "fetch", {});
		expect(status).toBe(400);
		expect(body.error?.category).toBe("validation");
		await service.close();
	});
});
