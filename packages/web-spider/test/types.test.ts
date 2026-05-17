/**
 * WBS-TSK-13: TDD tests for ImageRef and SpideredPage.images
 */

import { describe, expect, it } from "vitest";
import type { ImageRef, SpideredPage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid SpideredPage for structural tests. */
function makeMinimalPage(overrides: Partial<SpideredPage> = {}): SpideredPage {
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
		...overrides,
	};
}

/** Runtime guard: at least one of base64 or filePath must be present. */
function assertImageRefHasData(ref: ImageRef): void {
	if (!ref.base64 && !ref.filePath) {
		throw new Error("ImageRef must have at least one of base64 or filePath");
	}
}

// ---------------------------------------------------------------------------
// ImageRef structural tests
// ---------------------------------------------------------------------------

describe("ImageRef type", () => {
	it("accepts a minimal ImageRef with only required fields", () => {
		const ref: ImageRef = {
			src: "https://example.com/photo.jpg",
			mimeType: "image/jpeg",
			alt: "A photo",
		};
		expect(ref.src).toBe("https://example.com/photo.jpg");
		expect(ref.mimeType).toBe("image/jpeg");
		expect(ref.alt).toBe("A photo");
		expect(ref.base64).toBeUndefined();
		expect(ref.filePath).toBeUndefined();
	});

	it("accepts an ImageRef with base64", () => {
		const ref: ImageRef = {
			src: "https://example.com/photo.jpg",
			mimeType: "image/jpeg",
			alt: "A photo",
			base64: "abc123",
		};
		expect(ref.base64).toBe("abc123");
	});

	it("accepts an ImageRef with filePath", () => {
		const ref: ImageRef = {
			src: "https://example.com/large.jpg",
			mimeType: "image/jpeg",
			alt: "Large image",
			filePath: "/home/user/.cache/web-spider/images/abc123.jpg",
		};
		expect(ref.filePath).toContain("abc123.jpg");
	});

	it("accepts an ImageRef with both base64 and filePath", () => {
		const ref: ImageRef = {
			src: "https://example.com/photo.jpg",
			mimeType: "image/jpeg",
			alt: "",
			base64: "xyz",
			filePath: "/tmp/xyz.jpg",
		};
		expect(ref.base64).toBe("xyz");
		expect(ref.filePath).toBe("/tmp/xyz.jpg");
	});

	it("accepts empty string alt (no alt attribute)", () => {
		const ref: ImageRef = {
			src: "https://example.com/no-alt.jpg",
			mimeType: "image/jpeg",
			alt: "",
		};
		expect(ref.alt).toBe("");
	});

	it("accepts data: URL in src field", () => {
		const ref: ImageRef = {
			src: "data:image/png;base64,iVBORw0KGgo=",
			mimeType: "image/png",
			alt: "Inline image",
			base64: "iVBORw0KGgo=",
		};
		expect(ref.src).toMatch(/^data:/);
	});
});

// ---------------------------------------------------------------------------
// Runtime guard: assertImageRefHasData
// ---------------------------------------------------------------------------

describe("ImageRef data guard", () => {
	it("passes when base64 is present", () => {
		const ref: ImageRef = { src: "https://x.com/a.jpg", mimeType: "image/jpeg", alt: "", base64: "abc" };
		expect(() => assertImageRefHasData(ref)).not.toThrow();
	});

	it("passes when filePath is present", () => {
		const ref: ImageRef = { src: "https://x.com/a.jpg", mimeType: "image/jpeg", alt: "", filePath: "/tmp/a.jpg" };
		expect(() => assertImageRefHasData(ref)).not.toThrow();
	});

	it("throws when neither base64 nor filePath is present", () => {
		const ref: ImageRef = { src: "https://x.com/a.jpg", mimeType: "image/jpeg", alt: "" };
		expect(() => assertImageRefHasData(ref)).toThrow("at least one of base64 or filePath");
	});
});

// ---------------------------------------------------------------------------
// SpideredPage.images field
// ---------------------------------------------------------------------------

describe("SpideredPage.images field", () => {
	it("is optional — SpideredPage without images is valid", () => {
		const page = makeMinimalPage();
		expect(page.images).toBeUndefined();
	});

	it("accepts an empty images array", () => {
		const page = makeMinimalPage({ images: [] });
		expect(page.images).toEqual([]);
	});

	it("accepts a populated images array", () => {
		const images: ImageRef[] = [
			{ src: "https://example.com/a.jpg", mimeType: "image/jpeg", alt: "A", base64: "abc" },
			{ src: "https://example.com/b.png", mimeType: "image/png", alt: "B", base64: "def" },
		];
		const page = makeMinimalPage({ images });
		expect(page.images).toHaveLength(2);
		expect(page.images![0].src).toBe("https://example.com/a.jpg");
		expect(page.images![1].mimeType).toBe("image/png");
	});

	it("produces a valid LLM data URL from an ImageRef", () => {
		const ref: ImageRef = {
			src: "https://example.com/photo.jpg",
			mimeType: "image/jpeg",
			alt: "Photo",
			base64: "abc123XYZ",
		};
		const dataUrl = `data:${ref.mimeType};base64,${ref.base64}`;
		expect(dataUrl).toBe("data:image/jpeg;base64,abc123XYZ");
		expect(dataUrl).toMatch(/^data:image\//);
	});
});
