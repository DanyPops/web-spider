/**
 * WBS-TSK-16: TDD tests for DiskCache hybrid image persistence.
 * Uses real tmp directories — no mocking of fs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/disk-cache.js";
import type { ImageRef, SpideredPage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `wbs-disk-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function cachePath(): string {
	return join(testDir, "pages.json");
}

function makeCache(threshold = 32 * 1024): DiskCache {
	return new DiskCache(cachePath(), {
		ttlMs: 60 * 60 * 1000,
		autoFlush: false,
		inlineImageThreshold: threshold,
	});
}

function makeImage(base64: string, src = "https://example.com/photo.jpg"): ImageRef {
	return { src, mimeType: "image/jpeg", alt: "Test image", base64 };
}

function makePage(images: ImageRef[]): SpideredPage {
	return {
		url: "https://example.com",
		domain: "example.com",
		fetchedAt: new Date().toISOString(),
		title: "Test",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 0,
		readingTimeMinutes: 0,
		headings: [],
		chunks: [],
		links: [],
		markdown: "",
		images,
	};
}

/** Generate a base64 string of approximately `bytes` bytes when decoded. */
function makeBase64(bytes: number): string {
	return Buffer.alloc(bytes, 0xab).toString("base64");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiskCache hybrid image persistence", () => {
	it("1. small image (\u2264 threshold) is stored inline in JSON", () => {
		const cache = makeCache(32 * 1024);
		const b64 = makeBase64(100); // 100 bytes decoded \u226532KB threshold
		const page = makePage([makeImage(b64)]);

		cache.set("https://example.com", page);
		cache.flush();

		const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as { entries: Record<string, { page: SpideredPage }> };
		const entry = Object.values(raw.entries)[0];
		expect(entry.page.images![0].base64).toBe(b64);
		expect(entry.page.images![0].filePath).toBeUndefined();
	});

	it("2. large image (> threshold) is written to disk — JSON has filePath, no base64", () => {
		const cache = makeCache(32 * 1024);
		const b64 = makeBase64(40 * 1024); // 40KB decoded > 32KB threshold
		const page = makePage([makeImage(b64)]);

		cache.set("https://example.com", page);
		cache.flush();

		const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as { entries: Record<string, { page: SpideredPage }> };
		const entry = Object.values(raw.entries)[0];
		const storedImg = entry.page.images![0];

		expect(storedImg.base64).toBeUndefined();
		expect(storedImg.filePath).toBeDefined();
		expect(existsSync(storedImg.filePath!)).toBe(true);
	});

	it("3. large image is hydrated on get() after reload", () => {
		const b64 = makeBase64(40 * 1024);
		const page = makePage([makeImage(b64)]);

		const cache1 = makeCache(32 * 1024);
		cache1.set("https://example.com", page);
		cache1.flush();

		// Fresh cache instance — simulates restart
		const cache2 = makeCache(32 * 1024);
		const loaded = cache2.get("https://example.com");

		expect(loaded).toBeDefined();
		expect(loaded!.images![0].base64).toBe(b64);
	});

	it("4. missing binary file degrades gracefully — no throw, filePath preserved", () => {
		const b64 = makeBase64(40 * 1024);
		const page = makePage([makeImage(b64)]);

		const cache1 = makeCache(32 * 1024);
		cache1.set("https://example.com", page);
		cache1.flush();

		// Read the JSON to find the file path, then delete it
		const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as { entries: Record<string, { page: SpideredPage }> };
		const entry = Object.values(raw.entries)[0];
		const filePath = entry.page.images![0].filePath!;
		rmSync(filePath);

		const cache2 = makeCache(32 * 1024);
		let result: SpideredPage | undefined;
		expect(() => { result = cache2.get("https://example.com"); }).not.toThrow();
		expect(result).toBeDefined();
		expect(result!.images![0].filePath).toBeDefined();
		expect(result!.images![0].base64).toBeUndefined();
	});

	it("5. images/ directory is created automatically on first large-image flush", () => {
		const imagesDir = join(testDir, "images");
		expect(existsSync(imagesDir)).toBe(false);

		const cache = makeCache(32 * 1024);
		const b64 = makeBase64(40 * 1024);
		cache.set("https://example.com", makePage([makeImage(b64)]));
		cache.flush();

		expect(existsSync(imagesDir)).toBe(true);
	});

	it("page without images round-trips cleanly", () => {
		const cache1 = makeCache();
		const page = makePage([]);
		// Override images to be undefined (no captureImages)
		const noImgPage = { ...page, images: undefined };
		cache1.set("https://example.com", noImgPage);
		cache1.flush();

		const cache2 = makeCache();
		const loaded = cache2.get("https://example.com");
		expect(loaded).toBeDefined();
		expect(loaded!.images).toBeUndefined();
	});

	it("multiple images — mix of small and large — persisted correctly", () => {
		const smallB64 = makeBase64(100);
		const largeB64 = makeBase64(40 * 1024);
		const page = makePage([
			makeImage(smallB64, "https://example.com/small.jpg"),
			makeImage(largeB64, "https://example.com/large.jpg"),
		]);

		const cache1 = makeCache(32 * 1024);
		cache1.set("https://example.com", page);
		cache1.flush();

		const cache2 = makeCache(32 * 1024);
		const loaded = cache2.get("https://example.com");

		expect(loaded!.images).toHaveLength(2);
		// Small: inline
		const small = loaded!.images!.find((i) => i.src.includes("small"))!;
		expect(small.base64).toBe(smallB64);
		// Large: hydrated from file
		const large = loaded!.images!.find((i) => i.src.includes("large"))!;
		expect(large.base64).toBe(largeB64);
	});
});
