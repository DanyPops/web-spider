import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtempSyncRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "@danypops/vehicle-server/logging";
import type { IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { SQLiteCacheStore } from "../src/cache/sqlite-cache-store.ts";
import { QUOTES_MAX_URLS, QUOTES_PER_URL_CEILING, QUOTES_TOTAL_CEILING } from "../src/constants.ts";
import { openWebSpiderDb } from "../src/db.ts";
import { QuotesService } from "../src/fetch/quotes-service.ts";
import { fakeHttpClient } from "./helpers/fake-http-client.ts";

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

function blockRobots(): IRobotsChecker {
	return { check: async () => ({ allowed: false }) };
}

function makeService(httpClient: IHttpClient, robotsCache: IRobotsChecker = allowRobots(), logger?: Logger) {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const cache = new SQLiteCacheStore(db, { imagesDir });
	return new QuotesService({
		cache,
		throttle: noopThrottle(),
		robotsCache,
		defaultHttpClient: httpClient,
		getPlaywrightClient: () => httpClient,
		logger,
	});
}

// Page A repeats "rate limiting" across many distinct sentences (would dominate
// a flat topN ranking); Page B mentions it exactly once.
const PAGE_A = `<!DOCTYPE html><html><head><title>Page A</title></head><body><article>
  <h1>Page A</h1>
  <p>Rate limiting protects a server from being overwhelmed by too many requests.</p>
  <p>Effective rate limiting requires tracking request counts per client accurately.</p>
  <p>Distributed rate limiting is harder than single-node rate limiting in practice.</p>
  <p>A token bucket is one common rate limiting algorithm used in production systems.</p>
</article></body></html>`;

const PAGE_B = `<!DOCTYPE html><html><head><title>Page B</title></head><body><article>
  <h1>Page B</h1>
  <p>This article briefly mentions rate limiting once before moving to caching topics.</p>
  <p>Caching reduces load on origin servers by reusing previously computed responses.</p>
</article></body></html>`;

const URL_A = "https://fixture.test/a";
const URL_B = "https://fixture.test/b";

describe("QuotesService — validation", () => {
	test("throws on an empty query, before any fetch", async () => {
		const service = makeService(fakeHttpClient({}));
		await expect(service.quotes({ query: "   ", urls: [URL_A] })).rejects.toThrow(/query/i);
	});

	test("throws when no urls are given", async () => {
		const service = makeService(fakeHttpClient({}));
		await expect(service.quotes({ query: "rate limiting", urls: [] })).rejects.toThrow(/url/i);
	});
});

describe("QuotesService — resource cards", () => {
	test("returns one resource per requested url, each carrying quotes with citationUrl", async () => {
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A }, [URL_B]: { body: PAGE_B } }));
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A, URL_B] });
		expect(result.query).toBe("rate limiting");
		const resources = result.resources as Array<Record<string, unknown>>;
		expect(resources).toHaveLength(2);
		const a = resources.find((r) => r.url === URL_A)!;
		expect(a.title).toBe("Page A");
		expect(Array.isArray(a.quotes)).toBe(true);
		expect((a.quotes as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
		for (const quote of a.quotes as Array<Record<string, unknown>>) {
			expect(typeof quote.text).toBe("string");
			expect(typeof quote.citationUrl).toBe("string");
		}
	});

	test("deduplicates repeated urls in the request", async () => {
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A } }));
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A, URL_A, URL_A] });
		expect(result.urlsRequested).toBe(1);
		expect((result.resources as unknown[]).length).toBe(1);
	});
});

describe("QuotesService — per-URL quote cap", () => {
	test("caps quotes per url so one page cannot starve another's share of maxQuotesTotal", async () => {
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A }, [URL_B]: { body: PAGE_B } }));
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A, URL_B], maxQuotesPerUrl: 1, maxQuotesTotal: 10 });
		const resources = result.resources as Array<{ url: string; quotes: unknown[] }>;
		const a = resources.find((r) => r.url === URL_A)!;
		const b = resources.find((r) => r.url === URL_B)!;
		expect(a.quotes.length).toBe(1); // Page A has 4 matching sentences but must be capped to 1
		expect(b.quotes.length).toBeGreaterThanOrEqual(1); // Page B still gets its own quote, not starved by A
	});

	test("maxQuotesTotal bounds the combined quote count across every resource", async () => {
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A }, [URL_B]: { body: PAGE_B } }));
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A, URL_B], maxQuotesPerUrl: 10, maxQuotesTotal: 2 });
		const resources = result.resources as Array<{ quotes: unknown[] }>;
		const total = resources.reduce((sum, r) => sum + r.quotes.length, 0);
		expect(total).toBeLessThanOrEqual(2);
	});
});

describe("QuotesService — per-URL error isolation", () => {
	test("one robots-blocked url becomes an error resource without failing the whole batch", async () => {
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A }, [URL_B]: { body: PAGE_B } }), blockRobots());
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A, URL_B] });
		// Every url still gets exactly one resource entry.
		expect((result.resources as unknown[]).length).toBe(2);
	});

	test("ignoreRobots:true bypasses robots.txt for every requested url and is logged", async () => {
		const lines: string[] = [];
		const logger = createLogger("test", {
			level: "debug",
			destination: {
				write: (chunk: string) => {
					lines.push(chunk);
					return true;
				},
			},
		});
		const service = makeService(fakeHttpClient({ [URL_A]: { body: PAGE_A } }), blockRobots(), logger);
		const result = await service.quotes({ query: "rate limiting", urls: [URL_A], ignoreRobots: true });
		const resources = result.resources as Array<Record<string, unknown>>;
		expect(resources[0]!.error).toBeUndefined();
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", msg: "robots_txt_ignored", operation: "quotes" });
	});
});

describe("QuotesService — bounds sanity", () => {
	test("server-side ceilings are real, positive bounds", () => {
		expect(QUOTES_MAX_URLS).toBeGreaterThan(0);
		expect(QUOTES_PER_URL_CEILING).toBeGreaterThan(0);
		expect(QUOTES_TOTAL_CEILING).toBeGreaterThan(0);
	});
});

describe("QuotesService — maxCacheAgeMs", () => {
	// Builds its own db/cache (rather than the shared makeService() helper, which
	// returns a bare QuotesService) so this test can backdate a cached row's
	// fetched_at directly, matching sqlite-cache-store.test.ts's own established
	// pattern -- SQLiteCacheStore.set() always stamps fetched_at with its own
	// Date.now() at write time, so only a direct row UPDATE can simulate an aged entry.
	test("a cached page older than maxCacheAgeMs is refetched for this request, still re-cached for the next one", async () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const cache = new SQLiteCacheStore(db, { imagesDir });
		const httpClient = fakeHttpClient({ [URL_A]: { body: PAGE_A } });
		const service = new QuotesService({
			cache,
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: httpClient,
			getPlaywrightClient: () => httpClient,
		});

		await service.quotes({ query: "rate limiting", urls: [URL_A] });
		db.query("UPDATE pages SET fetched_at = ? WHERE url = ?").run(Date.now() - 60_000, URL_A);

		const stale = await service.quotes({ query: "rate limiting", urls: [URL_A], maxCacheAgeMs: 1_000 });
		expect((stale.resources as Array<{ error?: string }>)[0]?.error).toBeUndefined();

		// Not a full bypass: the refetch above wrote a fresh fetched_at, so a plain
		// (no maxCacheAgeMs) call afterward would again read a fresh row -- checked
		// indirectly here via the row no longer being 60s old.
		const row = db.query("SELECT fetched_at FROM pages WHERE url = ?").get(URL_A) as { fetched_at: number };
		expect(Date.now() - row.fetched_at).toBeLessThan(5_000);
	});
});
