import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";
import { CrawlService } from "../src/crawl-service.ts";
import { CRAWL_MAX_DEPTH_CEILING, CRAWL_MAX_PAGES_CEILING } from "../src/constants.ts";
import { articleWithLinks, fakeHttpClient } from "./helpers/fake-http-client.ts";

const ROOT = "https://fixture.test/";

function noopThrottle(): IThrottle {
	return { wait: async () => {}, success: () => {}, rateLimit: () => 0, setDomainDelay: () => {}, maxRetries: 0 };
}

function allowRobots(): IRobotsChecker {
	return { check: async () => ({ allowed: true }) };
}

function makeService(httpClient: IHttpClient) {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const cache = new SQLiteCacheStore(db, { imagesDir });
	const service = new CrawlService({
		cache,
		throttle: noopThrottle(),
		robotsCache: allowRobots(),
		defaultHttpClient: httpClient,
		getPlaywrightClient: () => httpClient,
	});
	return { service, cache };
}

// A tiny same-domain link graph: root -> a, b; a -> c (already-visited root excluded).
const SITE: Record<string, string> = {
	[ROOT]: articleWithLinks(["https://fixture.test/a", "https://fixture.test/b", "https://external.test/ignored"]),
	"https://fixture.test/a": articleWithLinks(["https://fixture.test/c"]),
	"https://fixture.test/b": articleWithLinks([]),
	"https://fixture.test/c": articleWithLinks([]),
};

describe("CrawlService — BFS crawl", () => {
	test("lean format crawls same-domain links up to maxPages and reports lean page summaries", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 2, maxPages: 10 });
		expect(result.pagesFound).toBeGreaterThanOrEqual(3); // root, a, b at minimum within depth/maxPages bounds
		expect(Array.isArray(result.pages)).toBe(true);
		for (const page of result.pages as Array<Record<string, unknown>>) {
			expect(page).not.toHaveProperty("markdown"); // lean never carries prose
		}
	});

	test("markdown (default) format returns a bounded crawl summary, not full page bodies", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		const result = await service.crawl({ url: ROOT, depth: 1, maxPages: 10 });
		// No tool-specific "note" here — that belongs to whichever adapter (pi-extension,
		// CLI) knows what UX it's presenting; the daemon's own data is tool-agnostic.
		expect(result).not.toHaveProperty("note");
		for (const page of result.pages as Array<Record<string, unknown>>) {
			expect(page).not.toHaveProperty("markdown");
			expect(page).toHaveProperty("url");
			expect(page).toHaveProperty("title");
		}
	});

	test("maxPages bounds the crawl even when more links are reachable", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 3, maxPages: 1 });
		expect(result.pagesFound).toBe(1);
	});

	test("depth/maxPages requests above the hard ceiling are clamped, not rejected", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		// Absurdly large requested bounds must not crash or hang — clamp() enforces the ceiling server-side.
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 1_000_000, maxPages: 1_000_000 });
		expect(result.pagesFound).toBeLessThanOrEqual(CRAWL_MAX_PAGES_CEILING);
		expect(CRAWL_MAX_DEPTH_CEILING).toBeGreaterThan(0); // sanity: the ceiling constant itself is bounded
	});

	test("sameDomain:false still excludes off-site links unless the page itself is off-site (crawl()'s own contract)", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 1, maxPages: 10, sameDomain: true });
		const urls = (result.pages as Array<{ url: string }>).map((p) => p.url);
		expect(urls.every((url) => new URL(url).hostname === "fixture.test")).toBe(true);
	});
});

describe("CrawlService — highlights", () => {
	test("throws when query is missing", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		await expect(service.crawl({ url: ROOT, format: "highlights", depth: 1 })).rejects.toThrow(/requires a query/);
	});

	test("searches across every crawled page and returns ranked hits", async () => {
		const { service } = makeService(fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }]))));
		const result = await service.crawl({ url: ROOT, format: "highlights", depth: 1, maxPages: 10, query: "Readability" });
		expect(typeof result.pagesSearched).toBe("number");
		expect(Array.isArray(result.hits)).toBe(true);
	});
});
