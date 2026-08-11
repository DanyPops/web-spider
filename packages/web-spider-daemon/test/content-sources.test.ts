/**
 * Daemon-level wiring of @danypops/web-spider's ContentSourceStrategy
 * extension point (docs/content-source-strategies.md): a `sources` daemon
 * input resolves to real strategies and reaches spider()/crawl() through
 * FetchService/CrawlService/QuotesService.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtempSyncRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { listRegisteredContentSources } from "@danypops/web-spider";
import { SQLiteCacheStore } from "../src/cache/sqlite-cache-store.ts";
import { openWebSpiderDb } from "../src/db.ts";
import { resolveSourcesOption } from "../src/fetch/content-sources.ts";
import { CrawlService } from "../src/fetch/crawl-service.ts";
import { FetchService } from "../src/fetch/fetch-service.ts";
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

function newCache() {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	return new SQLiteCacheStore(db, { imagesDir });
}

const GITHUB_URL = "https://github.com/DanyPops/web-spider";
const githubHttpClient: IHttpClient = fakeHttpClient({
	"https://api.github.com/repos/DanyPops/web-spider": {
		body: JSON.stringify({
			full_name: "DanyPops/web-spider",
			description: "A fixture repo",
			stargazers_count: 1,
			default_branch: "main",
		}),
		headers: { "content-type": "application/json" },
	},
	"https://api.github.com/repos/DanyPops/web-spider/readme": {
		body: JSON.stringify({ encoding: "base64", content: Buffer.from("# Fixture README").toString("base64") }),
		headers: { "content-type": "application/json" },
	},
});

describe("resolveSourcesOption", () => {
	test("returns undefined for an absent or empty list", () => {
		expect(resolveSourcesOption(undefined)).toBeUndefined();
		expect(resolveSourcesOption([])).toBeUndefined();
	});

	test("resolves built-in names into real strategies", () => {
		const resolved = resolveSourcesOption(["github", "mediawiki"]);
		expect(resolved?.map((s) => s.name)).toEqual(["github", "mediawiki"]);
	});

	test("throws a descriptive error listing every real name for an unknown one", () => {
		expect(() => resolveSourcesOption(["not-a-real-source"])).toThrow(/not-a-real-source/);
		try {
			resolveSourcesOption(["not-a-real-source"]);
		} catch (err) {
			for (const name of listRegisteredContentSources()) {
				expect((err as Error).message).toContain(name);
			}
		}
	});

	test("clamps to SOURCES_MAX_COUNT names", () => {
		const names = Array.from({ length: 50 }, () => "github");
		expect(resolveSourcesOption(names)?.length).toBeLessThanOrEqual(10);
	});
});

describe("FetchService — sources", () => {
	test("a matching named strategy wins over the normal fetch path, and reports viaStrategy", async () => {
		const service = new FetchService({
			cache: newCache(),
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: githubHttpClient,
			getPlaywrightClient: () => githubHttpClient,
		});
		const result = await service.fetch({ url: GITHUB_URL, sources: ["github"] });
		expect(result).toMatchObject({ viaStrategy: "github", title: "DanyPops/web-spider" });
	});

	test("an unknown source name throws a descriptive error before any fetch happens", async () => {
		const service = new FetchService({
			cache: newCache(),
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: githubHttpClient,
			getPlaywrightClient: () => githubHttpClient,
		});
		await expect(service.fetch({ url: GITHUB_URL, sources: ["bogus"] })).rejects.toThrow(/bogus/);
	});

	test("sources bypasses the shared cache, same as rootSelector/enhanced", async () => {
		const cache = newCache();
		const service = new FetchService({
			cache,
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: githubHttpClient,
			getPlaywrightClient: () => githubHttpClient,
		});
		await service.fetch({ url: GITHUB_URL, sources: ["github"] });
		expect(cache.get(GITHUB_URL)).toBeUndefined();
	});
});

describe("CrawlService — sources", () => {
	test("applies the named strategy to the crawl's start page", async () => {
		const service = new CrawlService({
			cache: newCache(),
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: githubHttpClient,
			getPlaywrightClient: () => githubHttpClient,
		});
		const result = (await service.crawl({ url: GITHUB_URL, sources: ["github"], format: "lean" })) as { pages: Array<{ url: string }> };
		expect(result.pages.some((page) => page.url === GITHUB_URL)).toBe(true);
	});
});

describe("QuotesService — sources", () => {
	test("applies the named strategy to every requested url", async () => {
		const service = new QuotesService({
			cache: newCache(),
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: githubHttpClient,
			getPlaywrightClient: () => githubHttpClient,
		});
		const result = (await service.quotes({ query: "fixture readme", urls: [GITHUB_URL], sources: ["github"] })) as {
			resources: Array<{ url: string; title?: string }>;
		};
		expect(result.resources[0]).toMatchObject({ url: GITHUB_URL, title: "DanyPops/web-spider" });
	});
});
