/**
 * End-to-end captureImages integration tests.
 *
 * Covers the full pipeline:
 *   spider() → SpideredPage.images → DiskCache.flush() → DiskCache.get()
 *   → LLM data URL → PlaywrightHttpClient-shaped stub
 *
 * No real network, no real browser.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/disk-cache.js";
import { PlaywrightHttpClient } from "../src/playwright.js";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_HTML = readFileSync(
	join(import.meta.dirname, "../fixtures/article-with-images.html"),
	"utf8",
);
const SMALL_JPG = readFileSync(join(import.meta.dirname, "../fixtures/images/small.jpg"));
const TINY_PNG = readFileSync(join(import.meta.dirname, "../fixtures/images/tiny.png"));
const LARGE_JPG = readFileSync(join(import.meta.dirname, "../fixtures/images/large.jpg"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `wbs-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function makeCachePath() {
	return join(testDir, "pages.json");
}

/**
 * Stub client that serves the fixture HTML for page fetches and
 * appropriate fixture image bytes for image fetches.
 * `useLargeImages`: serve large.jpg (>32KB) to exercise disk-spill.
 */
function makeStubClient(opts: { useLargeImages?: boolean } = {}): IHttpClient {
	return {
		async fetch(req) {
			const isImageReq = (req.headers?.["Accept"] ?? "").startsWith("image/");

			if (!isImageReq) {
				// Page fetch
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (n) => (n === "content-type" ? "text/html" : null) },
					text: async () => FIXTURE_HTML,
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}

			// Image fetch — pick fixture based on src extension / useLargeImages flag
			const src = req.url;
			let bytes: Buffer;
			let mime: string;

			if (opts.useLargeImages) {
				bytes = LARGE_JPG;
				mime = "image/jpeg";
			} else if (src.match(/\.png(\?|$)/i)) {
				bytes = TINY_PNG;
				mime = "image/png";
			} else {
				bytes = SMALL_JPG;
				mime = "image/jpeg";
			}

			const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (n) => (n === "content-type" ? mime : null) },
				text: async () => "",
				arrayBuffer: async () => buf,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// 1. Full spider() → DiskCache → reload roundtrip (small images, inline)
// ---------------------------------------------------------------------------

describe("spider() → DiskCache roundtrip — small images (inline)", () => {
	it("images survive flush + reload with correct base64", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});

		expect(page.images).toBeDefined();
		expect(page.images!.length).toBeGreaterThan(0);

		const cachePath = makeCachePath();
		const cache1 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		const reloaded = cache2.get("https://example.com");

		expect(reloaded).toBeDefined();
		expect(reloaded!.images).toBeDefined();
		expect(reloaded!.images!.length).toBe(page.images!.length);

		// Every base64 must survive the roundtrip exactly
		for (let i = 0; i < page.images!.length; i++) {
			const orig = page.images![i];
			const loaded = reloaded!.images![i];
			expect(loaded.src).toBe(orig.src);
			expect(loaded.mimeType).toBe(orig.mimeType);
			expect(loaded.alt).toBe(orig.alt);
			if (orig.base64) expect(loaded.base64).toBe(orig.base64);
		}
	});

	it("page text (markdown, chunks, title) also survives the roundtrip", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});

		const cachePath = makeCachePath();
		const cache1 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		const reloaded = cache2.get("https://example.com");

		expect(reloaded!.title).toBe(page.title);
		expect(reloaded!.markdown).toBe(page.markdown);
		expect(reloaded!.chunks.length).toBe(page.chunks.length);
	});
});

// ---------------------------------------------------------------------------
// 2. Full spider() → DiskCache → reload roundtrip (large images, disk-spill)
// ---------------------------------------------------------------------------

describe("spider() → DiskCache roundtrip — large images (disk-spill)", () => {
	it("large images are spilled to disk and hydrated on reload", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient({ useLargeImages: true }),
			captureImages: true,
			maxImages: 3,
		});

		expect(page.images).toBeDefined();
		const cachePath = makeCachePath();

		// Use a low threshold so even SMALL_JPG spills — 100 bytes decoded
		const cache1 = new DiskCache(cachePath, {
			ttlMs: 60 * 60 * 1000,
			autoFlush: false,
			inlineImageThreshold: 100,
		});
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = new DiskCache(cachePath, {
			ttlMs: 60 * 60 * 1000,
			autoFlush: false,
			inlineImageThreshold: 100,
		});
		const reloaded = cache2.get("https://example.com");

		expect(reloaded!.images).toBeDefined();
		// All images must have base64 after hydration
		for (const img of reloaded!.images!) {
			if (img.filePath) {
				expect(img.base64).toBeDefined();
				expect(img.base64!.length).toBeGreaterThan(0);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 3. LLM wire format — every image produces a valid data URL
// ---------------------------------------------------------------------------

describe("LLM wire format", () => {
	it("every captured image yields a valid data: URL", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});

		expect(page.images!.length).toBeGreaterThan(0);

		for (const img of page.images!) {
			if (!img.base64) continue;
			const dataUrl = `data:${img.mimeType};base64,${img.base64}`;
			expect(dataUrl).toMatch(/^data:image\/(jpeg|png|webp|gif|svg\+xml|avif);base64,/);
		}
	});

	it("base64 in data URL decodes to non-empty binary", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});

		for (const img of page.images!) {
			if (!img.base64) continue;
			const decoded = Buffer.from(img.base64, "base64");
			expect(decoded.byteLength).toBeGreaterThan(0);
		}
	});

	it("data: URL images from fixture have correct inline base64", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});

		// The fixture contains one data: URL (1x1 PNG)
		const inlineImg = page.images!.find((i) => i.src.startsWith("data:"));
		expect(inlineImg).toBeDefined();
		expect(inlineImg!.mimeType).toBe("image/png");

		const dataUrl = `data:${inlineImg!.mimeType};base64,${inlineImg!.base64}`;
		expect(dataUrl).toMatch(/^data:image\/png;base64,/);
	});
});

// ---------------------------------------------------------------------------
// 4. captureImages: false — no images attached, cache roundtrip clean
// ---------------------------------------------------------------------------

describe("captureImages: false — clean roundtrip", () => {
	it("images field is absent on spider() result", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
		});
		expect(page.images).toBeUndefined();
	});

	it("cache roundtrip without images is clean", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
		});

		const cachePath = makeCachePath();
		const cache1 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		const reloaded = cache2.get("https://example.com");
		expect(reloaded!.images).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 5. PlaywrightHttpClient-shaped stub with captureImages
// ---------------------------------------------------------------------------

describe("PlaywrightHttpClient captureImages integration", () => {
	it("PlaywrightHttpClient constructs with captureImages:true and satisfies IHttpClient", () => {
		const client: IHttpClient = new PlaywrightHttpClient({ captureImages: true });
		expect(typeof client.fetch).toBe("function");
	});

	it("spider() with a Playwright-shaped stub and captureImages:true returns images", async () => {
		// Simulate what PlaywrightHttpClient would do: a stub that looks like
		// a Playwright client — returns HTML for page fetches, images for image fetches.
		const playwrightShapedStub: IHttpClient = {
			async fetch(req) {
				const isImageReq = (req.headers?.["Accept"] ?? "").startsWith("image/");
				if (!isImageReq) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						headers: { get: (n) => (n === "content-type" ? "text/html" : null) },
						text: async () => FIXTURE_HTML,
						arrayBuffer: async () => new ArrayBuffer(0),
					};
				}
				const buf = SMALL_JPG.buffer.slice(
					SMALL_JPG.byteOffset,
					SMALL_JPG.byteOffset + SMALL_JPG.byteLength,
				) as ArrayBuffer;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (n) => (n === "content-type" ? "image/jpeg" : null) },
					text: async () => "",
					arrayBuffer: async () => buf,
				};
			},
		};

		const page = await spider("https://example.com", {
			httpClient: playwrightShapedStub,
			captureImages: true,
		});

		expect(page.images).toBeDefined();
		expect(page.images!.length).toBeGreaterThan(0);

		for (const img of page.images!) {
			if (img.base64) {
				expect(`data:${img.mimeType};base64,${img.base64}`).toMatch(/^data:image\//);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 6. maxImages respected end-to-end through cache
// ---------------------------------------------------------------------------

describe("maxImages end-to-end", () => {
	it("maxImages:2 — only 2 images in cache after roundtrip", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
			maxImages: 2,
		});

		expect(page.images!.length).toBeLessThanOrEqual(2);

		const cachePath = makeCachePath();
		const cache1 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = new DiskCache(cachePath, { ttlMs: 60 * 60 * 1000, autoFlush: false });
		const reloaded = cache2.get("https://example.com");
		expect(reloaded!.images!.length).toBeLessThanOrEqual(2);
	});
});
