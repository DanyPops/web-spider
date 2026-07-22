import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequest, HttpResponse, IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { createLogger } from "@danypops/daemon-kit/logging";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";
import { FetchService } from "../src/fetch-service.ts";
import { ARTICLE_HTML, fakeHttpClient } from "./helpers/fake-http-client.ts";

const URL = "https://fixture.test/article";

// A minimal app shell with no extractable article content — Readability finds
// nothing, so spider() reports jsRendered:true and FetchService retries with
// the injected Playwright client. Same fixture packages/pi-extension used to
// exercise this exact scenario before Playwright moved into this daemon.
const FIXTURES_DIR = join(import.meta.dir, "../../web-spider/fixtures");
const GH_SHELL_HTML = readFileSync(join(FIXTURES_DIR, "gh-shell.html"), "utf8");

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

	test("links format returns only body links — no top-level count (that is renderer-only metadata)", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const result = await service.fetch({ url: URL, format: "links" });
		expect(result.bodyLinks).toEqual([
			{ href: "https://fixture.test/related", text: "Related article" },
			{ href: "https://fixture.test/other", text: "Another link" },
		]);
		expect(result).not.toHaveProperty("links");
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

	test("ignoreRobots:true bypasses a robots.txt block for this one request", async () => {
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const cache = new SQLiteCacheStore(db, { imagesDir });
		const service = new FetchService({
			cache,
			throttle: noopThrottle(),
			robotsCache: blockRobots(),
			defaultHttpClient: fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }),
			getPlaywrightClient: () => fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }),
		});
		const blocked = await service.fetch({ url: URL });
		expect(blocked).toEqual({ blocked: true, url: URL, reason: "robots.txt" });

		const allowed = await service.fetch({ url: URL, ignoreRobots: true });
		expect(allowed).toMatchObject({ url: URL, title: "Fixture Article" });
	});

	test("ignoreRobots:true is logged (audited, not silent) -- never used without a trace", async () => {
		const lines: string[] = [];
		const logger = createLogger("test", { level: "debug", destination: { write: (chunk: string) => { lines.push(chunk); return true; } } });
		const db = openWebSpiderDb(":memory:");
		const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
		const cache = new SQLiteCacheStore(db, { imagesDir });
		const service = new FetchService({
			cache,
			throttle: noopThrottle(),
			robotsCache: allowRobots(),
			defaultHttpClient: fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }),
			getPlaywrightClient: () => fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }),
			logger,
		});

		await service.fetch({ url: URL }); // no ignoreRobots -- must not log
		expect(lines).toHaveLength(0);

		await service.fetch({ url: URL, ignoreRobots: true });
		expect(lines).toHaveLength(1);
		const logged = JSON.parse(lines[0]!);
		expect(logged).toMatchObject({ level: "warn", msg: "robots_txt_ignored", url: URL, operation: "fetch" });
	});

	test("never logs when no logger is configured (optional dependency, not a hard requirement)", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }), allowRobots());
		await expect(service.fetch({ url: URL, ignoreRobots: true })).resolves.toMatchObject({ title: "Fixture Article" });
	});
});

// ---------------------------------------------------------------------------
// Playwright auto-fallback — this behavior lived in packages/pi-extension
// before the extension-client task; it is exercised here now that Playwright
// is a daemon-owned adapter, via the same getPlaywrightClient() injection
// seam production code uses (see FetchServiceDeps).
// ---------------------------------------------------------------------------

function controllablePlaywrightClient(): { client: IHttpClient; setImpl: (fn: (req: HttpRequest) => Promise<HttpResponse>) => void; calls: number } {
	let impl: (req: HttpRequest) => Promise<HttpResponse> = async () => {
		throw new Error("playwright impl not set for this test");
	};
	let calls = 0;
	return {
		client: { fetch: async (req) => { calls += 1; return impl(req); } },
		setImpl: (fn) => { impl = fn; },
		get calls() { return calls; },
	};
}

function okResponse(body: string): HttpResponse {
	return {
		ok: true, status: 200, statusText: "OK",
		headers: { get: () => null },
		text: async () => body,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer,
	};
}

function serviceWithPlaywright(defaultBody: string | undefined) {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const cache = new SQLiteCacheStore(db, { imagesDir });
	const playwright = controllablePlaywrightClient();
	const service = new FetchService({
		cache,
		throttle: noopThrottle(),
		robotsCache: allowRobots(),
		// undefined ⇒ no route registered at all, so any call throws — proves
		// the default (non-Playwright) client was never consulted.
		defaultHttpClient: fakeHttpClient(defaultBody === undefined ? {} : { [URL]: { body: defaultBody } }),
		getPlaywrightClient: () => playwright.client,
	});
	return { service, playwright };
}

describe("FetchService — Playwright auto-fallback (jsRendered:true)", () => {
	test("retries with Playwright and returns article content when it succeeds", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => okResponse(ARTICLE_HTML));

		const result = await service.fetch({ url: URL, format: "lean" });
		expect(result.title).toBeTruthy();
		expect((result.wordCount as number)).toBeGreaterThan(0);
		expect(playwright.calls).toBe(1);
	});

	test("does not call Playwright when direct fetch already returns readable content", async () => {
		const { service, playwright } = serviceWithPlaywright(ARTICLE_HTML); // real article — Readability succeeds directly
		playwright.setImpl(async () => { throw new Error("Playwright should not have been called"); });

		const result = await service.fetch({ url: URL, format: "lean" });
		expect((result.wordCount as number)).toBeGreaterThan(0);
		expect(playwright.calls).toBe(0);
	});

	test("propagates a Playwright failure (browser closed unexpectedly) as a rejected fetch", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => { throw new Error("Browser closed unexpectedly"); });
		await expect(service.fetch({ url: URL })).rejects.toThrow("Browser closed unexpectedly");
	});

	test("propagates the cross-realm Map defect message verbatim", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => { throw new TypeError("Map operation called on non-Map object"); });
		await expect(service.fetch({ url: URL })).rejects.toThrow("Map operation called on non-Map object");
	});

	test("propagates a Playwright timeout message", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => { throw new Error("Timeout 30000ms exceeded."); });
		await expect(service.fetch({ url: URL })).rejects.toThrow("Timeout");
	});

	test("normalizes a non-Error Playwright throw", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => { throw "chromium launch failed"; });
		await expect(service.fetch({ url: URL })).rejects.toThrow("chromium launch failed");
	});
});

describe("FetchService — enhanced:true (Playwright for the first attempt, no fallback needed)", () => {
	test("returns content when Playwright succeeds on the first attempt", async () => {
		const { service, playwright } = serviceWithPlaywright(undefined); // default client must not be consulted at all
		playwright.setImpl(async () => okResponse(ARTICLE_HTML));

		const result = await service.fetch({ url: URL, format: "lean", enhanced: true });
		expect((result.wordCount as number)).toBeGreaterThan(0);
		expect(playwright.calls).toBe(1);
	});

	test("throws a native failure when the browser executable is missing", async () => {
		const { service, playwright } = serviceWithPlaywright(undefined);
		playwright.setImpl(async () => { throw new Error("executable doesn't exist at /nonexistent"); });
		await expect(service.fetch({ url: URL, enhanced: true })).rejects.toThrow("executable doesn't exist");
	});
});
