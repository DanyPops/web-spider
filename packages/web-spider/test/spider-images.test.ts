/**
 * TDD tests for spider() captureImages option.
 * No real network — uses stub IHttpClient.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

// ---------------------------------------------------------------------------
// Fixture HTML (loaded from disk)
// ---------------------------------------------------------------------------

const FIXTURE_HTML = readFileSync(
	join(import.meta.dirname, "../fixtures/article-with-images.html"),
	"utf8",
);

const TINY_PNG = readFileSync(join(import.meta.dirname, "../fixtures/images/tiny.png"));
const SMALL_JPG = readFileSync(join(import.meta.dirname, "../fixtures/images/small.jpg"));

// ---------------------------------------------------------------------------
// Stub HTTP client factory
// ---------------------------------------------------------------------------

/**
 * Returns a stub IHttpClient that serves the fixture HTML for page requests
 * and fixture image bytes for image requests.
 * `failOnSecond`: if true, throws on the second image fetch.
 */
function makeStubClient(opts: { failOnSecond?: boolean } = {}): IHttpClient {
	let imageFetchCount = 0;
	return {
		async fetch(req) {
			// Page request
			if (req.url.startsWith("https://example.com") && !req.url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i)) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (name) => (name === "content-type" ? "text/html" : null) },
					text: async () => FIXTURE_HTML,
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}

			// Image requests
			imageFetchCount++;
			if (opts.failOnSecond && imageFetchCount === 2) {
				throw new Error("Simulated network failure on second image");
			}

			// Serve fixture bytes based on extension
			const isJpeg = req.url.match(/\.(jpg|jpeg|webp)(\?|$)/i);
			const bytes = isJpeg ? SMALL_JPG : TINY_PNG;
			const mimeType = isJpeg ? "image/jpeg" : "image/png";
			const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name === "content-type" ? mimeType : null) },
				text: async () => "",
				arrayBuffer: async () => buf,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spider() captureImages option", () => {
	it("1. captureImages: false (default) — images field is undefined", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			// captureImages not set → defaults to false
		});
		expect(page.images).toBeUndefined();
	});

	it("2. captureImages: true — images array is populated", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		expect(page.images).toBeDefined();
		expect(page.images!.length).toBeGreaterThan(0);
	});

	it("3. ImageRef fields are populated correctly", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		for (const img of page.images!) {
			expect(img.src).toBeTruthy();
			expect(img.mimeType).toMatch(/^image\//);
			expect(typeof img.alt).toBe("string");
			// Either base64 or filePath must be set
			expect(img.base64 || img.filePath).toBeTruthy();
		}
	});

	it("4. maxImages cap is respected", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
			maxImages: 2,
		});
		expect(page.images!.length).toBeLessThanOrEqual(2);
	});

	it("5. relative src URLs are resolved to absolute", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		for (const img of page.images!) {
			// data: URLs are allowed as-is; all others must be absolute http(s)
			if (!img.src.startsWith("data:")) {
				expect(img.src).toMatch(/^https?:\/\//);
			}
		}
		// Specifically, the relative /images/chart.png should resolve to https://example.com/images/chart.png
		const resolved = page.images!.find((i) => i.src === "https://example.com/images/chart.png");
		expect(resolved).toBeDefined();
	});

	it("6. failed image fetch is skipped gracefully — no exception propagates", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient({ failOnSecond: true }),
			captureImages: true,
		});
		// Should still return a page — just with fewer images
		expect(page.images).toBeDefined();
		expect(page.url).toBe("https://example.com");
	});

	it("7. data: URL images are included without fetching", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		const dataImg = page.images!.find((i) => i.src.startsWith("data:"));
		expect(dataImg).toBeDefined();
		expect(dataImg!.mimeType).toBe("image/png");
		expect(dataImg!.base64).toBeTruthy();
	});

	it("base64 strings are valid (decodable)", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		for (const img of page.images!) {
			if (img.base64) {
				expect(() => Buffer.from(img.base64!, "base64")).not.toThrow();
				expect(Buffer.from(img.base64!, "base64").byteLength).toBeGreaterThan(0);
			}
		}
	});

	it("produces valid LLM data URLs from captured images", async () => {
		const page = await spider("https://example.com", {
			httpClient: makeStubClient(),
			captureImages: true,
		});
		for (const img of page.images!) {
			if (img.base64) {
				const dataUrl = `data:${img.mimeType};base64,${img.base64}`;
				expect(dataUrl).toMatch(/^data:image\//);
			}
		}
	});
});
