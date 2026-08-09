import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtempSyncRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { SQLiteCacheStore } from "../src/cache/sqlite-cache-store.ts";
import { CRAWL_MAX_DEADLINE_MS_CEILING, CRAWL_URLS_MAX_COUNT } from "../src/constants.ts";
import { openWebSpiderDb } from "../src/db.ts";
import { CrawlService } from "../src/fetch/crawl-service.ts";
import { articleWithLinks, fakeHttpClient } from "./helpers/fake-http-client.ts";

const ROOT = "https://fixture.test/";
const tmpDirs: string[] = [];
function mkdtempSync(prefix: string): string {
	const dir = mkdtempSyncRaw(prefix);
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
	return new CrawlService({
		cache,
		throttle: noopThrottle(),
		robotsCache: allowRobots(),
		defaultHttpClient: httpClient,
		getPlaywrightClient: () => httpClient,
	});
}

// A tiny same-domain link graph: root -> a, b; a -> c.
const SITE: Record<string, string> = {
	[ROOT]: articleWithLinks(["https://fixture.test/a", "https://fixture.test/b"]),
	"https://fixture.test/a": articleWithLinks(["https://fixture.test/c"]),
	"https://fixture.test/b": articleWithLinks([]),
	"https://fixture.test/c": articleWithLinks([]),
};

function siteHttpClient(): IHttpClient {
	return fakeHttpClient(Object.fromEntries(Object.entries(SITE).map(([url, body]) => [url, { body }])));
}

describe("CrawlService — page_type / content_ok / nextAction on the wire", () => {
	test("lean format exposes pageType and contentOk per page", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 1, maxPages: 10 });
		const pages = result.pages as Array<Record<string, unknown>>;
		expect(pages.length).toBeGreaterThan(0);
		for (const page of pages) {
			expect(typeof page.pageType).toBe("string");
			expect(typeof page.contentOk).toBe("boolean");
		}
	});

	test("markdown format exposes pageType/contentOk per page and nextAction at top level", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({ url: ROOT, format: "markdown", depth: 1, maxPages: 10 });
		expect(typeof result.nextAction).toBe("string");
		const pages = result.pages as Array<Record<string, unknown>>;
		for (const page of pages) {
			expect(typeof page.pageType).toBe("string");
		}
	});

	test("nextAction reports max-pages when the server-clamped maxPages stops the crawl early", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 3, maxPages: 1 });
		expect(result.nextAction).toBe("max-pages");
	});
});

describe("CrawlService — discoverOnly", () => {
	test("returns URL/title/pageType metadata but no markdown body", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 1, maxPages: 10, discoverOnly: true });
		const pages = result.pages as Array<Record<string, unknown>>;
		expect(pages.length).toBeGreaterThan(0);
		for (const page of pages) {
			expect(page).not.toHaveProperty("markdown");
			expect(page.url).toBeTruthy();
		}
	});
});

describe("CrawlService — crawlUrls (selective second-phase crawl)", () => {
	test("fetches exactly the given URLs and does not discover further links", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({
			url: ROOT,
			format: "lean",
			crawlUrls: ["https://fixture.test/a", "https://fixture.test/b"],
		});
		const urls = (result.pages as Array<{ url: string }>).map((p) => p.url).sort();
		expect(urls).toEqual(["https://fixture.test/a", "https://fixture.test/b"]);
	});

	test("a crawlUrls list beyond the server ceiling is clamped, not rejected", async () => {
		const service = makeService(siteHttpClient());
		const tooMany = Array.from({ length: CRAWL_URLS_MAX_COUNT + 20 }, (_, i) => `https://fixture.test/extra-${i}`);
		// Should not throw even though every one of these 404s against the fixture site.
		const result = await service.crawl({ url: ROOT, format: "lean", crawlUrls: tooMany });
		expect(typeof result.pagesFound).toBe("number");
	});
});

describe("CrawlService — maxTotalChars / deadlineMs budgets", () => {
	test("maxTotalChars stops the crawl early and reports nextAction", async () => {
		const service = makeService(siteHttpClient());
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 3, maxPages: 10, maxTotalChars: 10 });
		expect(result.nextAction).toBe("max-total-chars");
	});

	test("an absurd deadlineMs request is clamped server-side to the ceiling, not honored as unbounded", async () => {
		const service = makeService(siteHttpClient());
		// Must not hang — clamp() enforces CRAWL_MAX_DEADLINE_MS_CEILING server-side.
		const result = await service.crawl({ url: ROOT, format: "lean", depth: 1, deadlineMs: 1_000_000_000 });
		expect(typeof result.pagesFound).toBe("number");
		expect(CRAWL_MAX_DEADLINE_MS_CEILING).toBeLessThan(1_000_000_000);
	});
});
