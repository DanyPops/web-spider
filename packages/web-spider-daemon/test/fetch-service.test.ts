import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtempSyncRaw, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@danypops/vehicle-server/logging";
import type { HttpRequest, HttpResponse, IHttpClient, IRobotsChecker, IThrottle } from "@danypops/web-spider";
import { SQLiteCacheStore } from "../src/cache/sqlite-cache-store.ts";
import { openWebSpiderDb } from "../src/db.ts";
import { FetchService } from "../src/fetch/fetch-service.ts";
import { ARTICLE_HTML, fakeHttpClient } from "./helpers/fake-http-client.ts";

const URL = "https://fixture.test/article";
const tmpDirs: string[] = [];
function mkdtempSync(prefix: string): string {
	const dir = mkdtempSyncRaw(prefix);
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A minimal app shell with no extractable article content — Readability finds
// nothing, so spider() reports jsRendered:true and FetchService retries with
// the injected Playwright client. Same fixture packages/pi-web-spider used to
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
	return { service, cache, db };
}

/**
 * Backdates a cached row's fetched_at column directly via SQL -- SQLiteCacheStore.set()
 * always stamps fetched_at with its own Date.now() at write time (matching
 * sqlite-cache-store.test.ts's own established pattern), so mutating a
 * SpideredPage's fetchedAt field and re-calling cache.set() would not actually
 * persist an old timestamp; only a direct row UPDATE does.
 */
function backdateFetchedAt(db: ReturnType<typeof openWebSpiderDb>, url: string, ageMs: number): void {
	db.query("UPDATE pages SET fetched_at = ? WHERE url = ?").run(Date.now() - ageMs, url);
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

describe("FetchService — bounded PDF text-layer extraction", () => {
	const pdfUrl = "https://fixture.test/report.bin";
	const pdfFixtures = join(import.meta.dir, "../../web-spider/test/fixtures/pdf");

	function pdfClient(name: string, contentType = "application/octet-stream", onFetch?: () => void): IHttpClient {
		const bytes = readFileSync(join(pdfFixtures, name));
		return {
			async fetch(): Promise<HttpResponse> {
				onFetch?.();
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (header) => (header.toLowerCase() === "content-type" ? contentType : null) },
					text: async () => bytes.toString("utf8"),
					arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
				};
			},
		};
	}

	test("forwards a bounded page range and exposes PDF/quality metadata on the markdown wire", async () => {
		const { service } = makeService(pdfClient("multi-page.pdf"));
		const result = await service.fetch({ url: pdfUrl, pdfPageStart: 2, pdfPageEnd: 3 });
		expect(result).toMatchObject({
			contentOk: true,
			truncated: true,
			pdf: { totalPages: 3, pageStart: 2, pageEnd: 3, truncated: true },
		});
		expect(result.markdown).toContain("--- Page 2 ---");
		expect(result.markdown).toContain("--- Page 3 ---");
		expect(result.markdown).not.toContain("--- Page 1 ---");
	});

	test("marks normalized source incomplete when the selected PDF range is partial", async () => {
		const { service } = makeService(pdfClient("multi-page.pdf", "application/pdf"));
		await expect(service.fetch({ url: pdfUrl, format: "source", pdfPageStart: 2, pdfPageEnd: 2 })).resolves.toMatchObject({
			contentType: "application/pdf",
			complete: false,
			truncated: true,
			pdf: { totalPages: 3, pageStart: 2, pageEnd: 2, truncated: true },
		});
	});

	test("keeps explicit page ranges cache-ineligible while preserving default PDF cache behavior", async () => {
		let calls = 0;
		const { service } = makeService(pdfClient("multi-page.pdf", "application/pdf", () => calls++));
		await service.fetch({ url: pdfUrl, pdfPageStart: 2, pdfPageEnd: 2 });
		await service.fetch({ url: pdfUrl, pdfPageStart: 2, pdfPageEnd: 2 });
		expect(calls).toBe(2);

		const first = await service.fetch({ url: pdfUrl });
		const second = await service.fetch({ url: pdfUrl });
		expect(calls).toBe(3);
		expect(second).toMatchObject({ contentOk: true, pdf: first.pdf, cache: "hit" });
	});

	test("preserves an honest no-text-layer signal for scanned PDFs", async () => {
		const { service } = makeService(pdfClient("scanned.pdf", "application/pdf"));
		await expect(service.fetch({ url: pdfUrl })).resolves.toMatchObject({
			contentOk: false,
			contentWarning: "no-text-layer",
			pdf: { totalPages: 1 },
		});
	});

	test("recovers a genuinely image-only PDF via the OCR fallback and exposes ocrPages/qualityScore on the wire", async () => {
		const { service } = makeService(pdfClient("recoverable-scanned.pdf", "application/pdf"));
		const result = await service.fetch({ url: pdfUrl });
		const pdf = result.pdf as { totalPages: number; ocrPages?: number[]; qualityScore?: number } | undefined;
		expect(result.contentOk).toBe(true);
		expect(pdf).toMatchObject({ totalPages: 1, ocrPages: [1] });
		expect(pdf?.qualityScore).toBeGreaterThan(0.5);
		expect(result.markdown).toContain("Recovered by OCR fallback");
	}, 30_000);
});

describe("FetchService — normalized source format", () => {
	const sourceUrl = "https://fixture.test/data";

	test("pretty-prints complete JSON and preserves identical cache semantics", async () => {
		const { service } = makeService(
			fakeHttpClient({
				[sourceUrl]: { body: '{"answer":42,"items":[1,2]}', headers: { "content-type": "application/json" } },
			}),
		);
		const first = await service.fetch({ url: sourceUrl, format: "source" as never });
		expect(first).toEqual({
			url: sourceUrl,
			contentType: "application/json",
			content: '{\n  "answer": 42,\n  "items": [\n    1,\n    2\n  ]\n}',
			complete: true,
			truncated: false,
			cache: "miss",
		});
		const second = await service.fetch({ url: sourceUrl, format: "source" as never });
		expect(second).toEqual({ ...first, cache: "hit" });
	});

	test.each([
		["plain text", "text/plain", "hello source"],
		["malformed JSON", "application/json", '{"broken":'],
		["JSONL", "application/x-ndjson", '{"a":1}\n{"a":2}\n'],
		["empty text", "text/plain", ""],
	])("returns normalized textual source for %s", async (_name, contentType, body) => {
		const { service } = makeService(fakeHttpClient({ [sourceUrl]: { body, headers: { "content-type": contentType } } }));
		const result = await service.fetch({ url: sourceUrl, format: "source" as never });
		expect(result).toMatchObject({ url: sourceUrl, contentType, content: body, complete: true, truncated: false });
	});

	test("returns extracted markdown for HTML and names its media type honestly", async () => {
		const { service } = makeService(
			fakeHttpClient({ [URL]: { body: ARTICLE_HTML, headers: { "content-type": "text/html; charset=utf-8" } } }),
		);
		const result = await service.fetch({ url: URL, format: "source" as never });
		expect(result).toMatchObject({ url: URL, contentType: "text/html", complete: true, truncated: false });
		expect(result.content).toContain("Section One");
		expect(result.content).not.toContain("<!DOCTYPE html>");
	});

	test("rejects binary content instead of pretending it is textual source", async () => {
		const { service } = makeService(
			fakeHttpClient({ [sourceUrl]: { body: "not really bytes", headers: { "content-type": "application/octet-stream" } } }),
		);
		await expect(service.fetch({ url: sourceUrl, format: "source" as never })).rejects.toThrow(/cannot parse as text or structure/i);
	});

	test("bounds source content and marks truncated JSON as incomplete", async () => {
		const body = JSON.stringify({ value: "abcdefghijklmnopqrstuvwxyz" });
		const { service } = makeService(fakeHttpClient({ [sourceUrl]: { body, headers: { "content-type": "application/json" } } }));
		const result = await service.fetch({ url: sourceUrl, format: "source" as never, tokenBudget: 4 });
		expect(result).toMatchObject({ contentType: "application/json", complete: false, truncated: true });
		expect((result.content as string).length).toBeLessThanOrEqual(16);
		expect(() => JSON.parse(result.content as string)).toThrow();
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

const RICH_META_HTML = `<!DOCTYPE html>
<html><head>
<title>Rich Meta Fixture</title>
<meta property="og:title" content="Rich Meta OG Title" />
<meta property="og:description" content="An OG description" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@type":"Article","headline":"Rich Meta Fixture"}</script>
</head>
<body><article><h1>Rich Meta Fixture</h1><p>${"Enough article prose for Readability to extract this as a real article. ".repeat(20)}</p></article></body></html>`;

describe("FetchService — meta format", () => {
	test("returns only structured metadata -- openGraph/twitterCard/jsonLd, never markdown/chunks", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: RICH_META_HTML } }));
		const result = await service.fetch({ url: URL, format: "meta" });
		expect(result).toMatchObject({
			url: URL,
			// Readability prefers og:title over the <title> tag when both are present.
			title: "Rich Meta OG Title",
			openGraph: { "og:title": "Rich Meta OG Title", "og:description": "An OG description" },
			twitterCard: { "twitter:card": "summary" },
			jsonLd: [{ "@type": "Article", headline: "Rich Meta Fixture" }],
		});
		expect(result).not.toHaveProperty("markdown");
		expect(result).not.toHaveProperty("chunks");
	});

	test("a page with none of these present omits all three fields entirely", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		const result = await service.fetch({ url: URL, format: "meta" });
		expect(result).not.toHaveProperty("openGraph");
		expect(result).not.toHaveProperty("twitterCard");
		expect(result).not.toHaveProperty("jsonLd");
		expect(result).toMatchObject({ url: URL, title: "Fixture Article" });
	});

	test("is a normal cache-eligible format -- miss then hit, with the same metadata surviving the SQLite round-trip", async () => {
		const { service } = makeService(fakeHttpClient({ [URL]: { body: RICH_META_HTML } }));
		const first = await service.fetch({ url: URL, format: "meta" });
		expect(first.cache).toBe("miss");
		const second = await service.fetch({ url: URL, format: "meta" });
		expect(second.cache).toBe("hit");
		// Regression guard: openGraph/twitterCard/jsonLd must survive a real cache
		// hit, not just a fresh extraction -- the SQLite cache store persists
		// SpideredPage via named columns, not a blob, so a new field silently
		// vanishes on hit unless the store is explicitly taught about it too.
		expect(second).toMatchObject({
			openGraph: { "og:title": "Rich Meta OG Title", "og:description": "An OG description" },
			twitterCard: { "twitter:card": "summary" },
			jsonLd: [{ "@type": "Article", headline: "Rich Meta Fixture" }],
		});
	});
});

describe("FetchService — maxCacheAgeMs", () => {
	test("a cached hit older than maxCacheAgeMs is treated as a miss, and the fresh result is still written back to the shared cache", async () => {
		const { service, db } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		await service.fetch({ url: URL });
		backdateFetchedAt(db, URL, 60_000); // age it 60s

		// A tighter bound than the entry's real age rejects the stale hit.
		const stale = await service.fetch({ url: URL, maxCacheAgeMs: 1_000 });
		expect(stale.cache).toBe("miss");

		// Not a full bypass: the miss above re-cached with a fresh fetchedAt, so a
		// plain call with no override now hits again.
		const afterward = await service.fetch({ url: URL });
		expect(afterward.cache).toBe("hit");
	});

	test("a cached hit within maxCacheAgeMs is still served normally", async () => {
		const { service, db } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		await service.fetch({ url: URL });
		backdateFetchedAt(db, URL, 60_000);

		const result = await service.fetch({ url: URL, maxCacheAgeMs: 120_000 });
		expect(result.cache).toBe("hit");
	});

	test("maxCacheAgeMs: 0 always refetches, still caching the fresh result for later callers", async () => {
		const { service, db } = makeService(fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }));
		await service.fetch({ url: URL });
		backdateFetchedAt(db, URL, 1); // even 1ms old must be rejected by maxCacheAgeMs:0
		const forced = await service.fetch({ url: URL, maxCacheAgeMs: 0 });
		expect(forced.cache).toBe("miss");
		const afterward = await service.fetch({ url: URL });
		expect(afterward.cache).toBe("hit");
	});

	test("format:tree bypasses the in-memory tree cache entirely when maxCacheAgeMs is set -- each call re-fetches", async () => {
		let fetchCount = 0;
		const counting: IHttpClient = {
			async fetch(req: HttpRequest): Promise<HttpResponse> {
				fetchCount++;
				return fakeHttpClient({ [URL]: { body: ARTICLE_HTML } }).fetch(req);
			},
		};
		const { service } = makeService(counting);

		await service.fetch({ url: URL, format: "tree", maxCacheAgeMs: 60_000 });
		const afterFirst = fetchCount;
		await service.fetch({ url: URL, format: "tree", maxCacheAgeMs: 60_000 });
		expect(fetchCount).toBeGreaterThan(afterFirst); // no memoized hit -- a real second fetch happened
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
		const logger = createLogger("test", {
			level: "debug",
			destination: {
				write: (chunk: string) => {
					lines.push(chunk);
					return true;
				},
			},
		});
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
// Playwright auto-fallback — this behavior lived in packages/pi-web-spider
// before the extension-client task; it is exercised here now that Playwright
// is a daemon-owned adapter, via the same getPlaywrightClient() injection
// seam production code uses (see FetchServiceDeps).
// ---------------------------------------------------------------------------

function controllablePlaywrightClient(): {
	client: IHttpClient;
	setImpl: (fn: (req: HttpRequest) => Promise<HttpResponse>) => void;
	calls: number;
} {
	let impl: (req: HttpRequest) => Promise<HttpResponse> = async () => {
		throw new Error("playwright impl not set for this test");
	};
	let calls = 0;
	return {
		client: {
			fetch: async (req) => {
				calls += 1;
				return impl(req);
			},
		},
		setImpl: (fn) => {
			impl = fn;
		},
		get calls() {
			return calls;
		},
	};
}

function okResponse(body: string): HttpResponse {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
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
		expect(result.wordCount as number).toBeGreaterThan(0);
		expect(playwright.calls).toBe(1);
	});

	test("does not call Playwright when direct fetch already returns readable content", async () => {
		const { service, playwright } = serviceWithPlaywright(ARTICLE_HTML); // real article — Readability succeeds directly
		playwright.setImpl(async () => {
			throw new Error("Playwright should not have been called");
		});

		const result = await service.fetch({ url: URL, format: "lean" });
		expect(result.wordCount as number).toBeGreaterThan(0);
		expect(playwright.calls).toBe(0);
	});

	test("propagates a Playwright failure (browser closed unexpectedly) as a rejected fetch", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => {
			throw new Error("Browser closed unexpectedly");
		});
		await expect(service.fetch({ url: URL })).rejects.toThrow("Browser closed unexpectedly");
	});

	test("propagates the cross-realm Map defect message verbatim", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => {
			throw new TypeError("Map operation called on non-Map object");
		});
		await expect(service.fetch({ url: URL })).rejects.toThrow("Map operation called on non-Map object");
	});

	test("translates a Playwright timeout to the same typed transport failure contract", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => {
			throw new Error("Timeout 30000ms exceeded.");
		});
		const failure = await service.fetch({ url: URL }).catch((error) => error);
		expect(failure).toMatchObject({
			code: "fetch-transport-failed",
			kind: "timeout",
			diagnostic: "Connection timed out",
			retryable: true,
		});
	});

	test("normalizes a non-Error Playwright throw", async () => {
		const { service, playwright } = serviceWithPlaywright(GH_SHELL_HTML);
		playwright.setImpl(async () => {
			throw "chromium launch failed";
		});
		await expect(service.fetch({ url: URL })).rejects.toThrow("chromium launch failed");
	});
});

describe("FetchService — enhanced:true (Playwright for the first attempt, no fallback needed)", () => {
	test("returns content when Playwright succeeds on the first attempt", async () => {
		const { service, playwright } = serviceWithPlaywright(undefined); // default client must not be consulted at all
		playwright.setImpl(async () => okResponse(ARTICLE_HTML));

		const result = await service.fetch({ url: URL, format: "lean", enhanced: true });
		expect(result.wordCount as number).toBeGreaterThan(0);
		expect(playwright.calls).toBe(1);
	});

	test("throws a native failure when the browser executable is missing", async () => {
		const { service, playwright } = serviceWithPlaywright(undefined);
		playwright.setImpl(async () => {
			throw new Error("executable doesn't exist at /nonexistent");
		});
		await expect(service.fetch({ url: URL, enhanced: true })).rejects.toThrow("executable doesn't exist");
	});
});
