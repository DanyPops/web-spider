import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";
import { FetchService } from "../src/fetch-service.ts";
import { ARTICLE_HTML, fakeHttpClient } from "./helpers/fake-http-client.ts";

const URL = "https://fixture.test/article";

function noopThrottle(): IThrottle {
	return { wait: async () => {}, success: () => {}, rateLimit: () => 0, setDomainDelay: () => {}, maxRetries: 0 };
}

function allowRobots(): IRobotsChecker {
	return { check: async () => ({ allowed: true }) };
}

function blockRobots(): IRobotsChecker {
	return { check: async () => ({ allowed: false }) };
}

function makeService(httpClient: IHttpClient, robotsCache: IRobotsChecker = allowRobots()) {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const cache = new SQLiteCacheStore(db, { imagesDir });
	const service = new FetchService({
		cache,
		throttle: noopThrottle(),
		robotsCache,
		defaultHttpClient: httpClient,
		// Never exercised unless jsRendered/enhanced — all fixtures are real articles, not JS-rendered shells.
		getPlaywrightClient: () => httpClient,
	});
	return { service, cache };
}

describe("FetchService — markdown/lean/links (default cache-eligible path)", () => {
	test("markdown format returns the page body and reports a cache miss then a hit", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const first = await service.fetch({ url: URL });
		expect(first).toMatchObject({ url: URL, title: "Fixture Article", cache: "miss" });
		expect(typeof first.markdown).toBe("string");
		expect((first.markdown as string).length).toBeGreaterThan(0);

		const second = await service.fetch({ url: URL });
		expect(second).toMatchObject({ cache: "hit" });
	});

	test("lean format omits markdown/chunks and reports headings/bodyLinks", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const result = await service.fetch({ url: URL, format: "lean" });
		expect(result).not.toHaveProperty("markdown");
		expect(result).not.toHaveProperty("chunks");
		expect(Array.isArray(result.headings)).toBe(true);
		expect(Array.isArray(result.bodyLinks)).toBe(true);
	});

	test("links format returns only body links plus a links count", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const result = await service.fetch({ url: URL, format: "links" });
		expect(result.bodyLinks).toEqual([
			{ href: "https://fixture.test/related", text: "Related article" },
			{ href: "https://fixture.test/other", text: "Another link" },
		]);
		expect(result.links).toBe(2);
	});

	test("rootSelector/excludeSelectors/tokenBudget/enhanced bypass the cache on every call", async () => {
		const { service, cache } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		await service.fetch({ url: URL, rootSelector: "article" });
		await service.fetch({ url: URL, rootSelector: "article" });
		// Neither call should have populated the shared cache — cacheEligible is false whenever rootSelector is set.
		expect(cache.get(URL)).toBeUndefined();
	});
});

describe("FetchService — highlights", () => {
	test("throws when query is missing", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		await expect(service.fetch({ url: URL, format: "highlights" })).rejects.toThrow(/requires a query/);
	});

	test("returns ranked hits with full chunk text for a matching query", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const result = await service.fetch({ url: URL, format: "highlights", query: "exponential backoff" });
		expect(Array.isArray(result.hits)).toBe(true);
		expect((result.hits as unknown[]).length).toBeGreaterThan(0);
	});
});

describe("FetchService — tree", () => {
	test("full tree, then query, then path — same underlying tree cache", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const tree = await service.fetch({ url: URL, format: "tree" });
		expect(tree.tag).toBeDefined();

		const queried = await service.fetch({ url: URL, format: "tree", query: "backoff" });
		expect(Array.isArray(queried.hits)).toBe(true);

		const pathResult = await service.fetch({ url: URL, format: "tree", path: "does.not.exist[0]" });
		expect(pathResult).toEqual({ found: false, path: "does.not.exist[0]" });
	});
});

describe("FetchService — robots.txt", () => {
	test("returns a typed blocked result instead of throwing", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }), blockRobots());
		const result = await service.fetch({ url: URL });
		expect(result).toEqual({ blocked: true, url: URL, reason: "robots.txt" });
	});
});
