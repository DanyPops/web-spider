import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { FetchedResource } from "../src/fetch/content-extractor.js";
import type { PdfExtractor } from "../src/fetch/pdf-extractor.js";
import { UnpdfPdfExtractor } from "../src/fetch/pdf-extractor.js";
import type { OcrEngine, PdfPageImage, PdfPageRasterizer } from "../src/fetch/pdf-ocr.js";
import { OcrFallbackPdfExtractor, TesseractOcrEngine, UnpdfPageRasterizer } from "../src/fetch/pdf-ocr.js";
import { PdfContentExtractor } from "../src/index.js";

const FIXTURES = new URL("./fixtures/pdf/", import.meta.url);

async function fixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

function resource(bytes: Uint8Array): FetchedResource {
	return {
		url: "https://example.com/reports/scan.pdf",
		domain: "example.com",
		fetchedAt: "2026-08-09T00:00:00.000Z",
		contentType: "application/pdf",
		bytes,
	};
}

function fakeRasterizer(impl: (bytes: Uint8Array, pageNumber: number) => Promise<PdfPageImage>): PdfPageRasterizer {
	return { renderPage: vi.fn(impl) };
}

function fakeOcr(impl: (image: PdfPageImage) => Promise<{ text: string; confidence: number }>): OcrEngine {
	return { recognize: vi.fn(impl) };
}

describe("OcrFallbackPdfExtractor — unit tests with fake ports", () => {
	const inner: PdfExtractor = {
		extract: vi.fn().mockResolvedValue({
			totalPages: 3,
			pages: [
				{ number: 1, text: "A perfectly normal text layer." },
				{ number: 2, text: "" },
				{ number: 3, text: "￿￿￿￿￿￿" },
			],
			outline: [{ title: "Intro", page: 1, level: 1 }],
			metadata: { title: "Fixture" },
		}),
	};

	it("only rasterizes/OCRs pages whose text is empty or garbled — a good page is left untouched", async () => {
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => ({ text: "recovered", confidence: 0.9 }));
		const extractor = new OcrFallbackPdfExtractor(inner, rasterizer, ocr);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 3 });

		expect(rasterizer.renderPage).toHaveBeenCalledTimes(2);
		expect(rasterizer.renderPage).toHaveBeenCalledWith(expect.any(Uint8Array), 2);
		expect(rasterizer.renderPage).toHaveBeenCalledWith(expect.any(Uint8Array), 3);
		expect(result.pages[0]).toEqual({ number: 1, text: "A perfectly normal text layer." });
	});

	it("replaces empty/garbled page text with recovered OCR text and records which pages were recovered", async () => {
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => ({ text: "recovered text", confidence: 0.87 }));
		const extractor = new OcrFallbackPdfExtractor(inner, rasterizer, ocr);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 3 });

		expect(result.pages[1]).toEqual({ number: 2, text: "recovered text" });
		expect(result.pages[2]).toEqual({ number: 3, text: "recovered text" });
		expect(result.ocrPages).toEqual([2, 3]);
		// Unrelated extraction fields pass through untouched.
		expect(result.totalPages).toBe(3);
		expect(result.outline).toEqual([{ title: "Intro", page: 1, level: 1 }]);
		expect(result.metadata).toEqual({ title: "Fixture" });
	});

	it("a rasterizer failure on one page never fails the whole extraction — that page keeps its original text", async () => {
		const rasterizer = fakeRasterizer(async (_bytes, pageNumber) => {
			if (pageNumber === 2) throw new Error("Convert String to CString failed");
			return { bytes: new Uint8Array([1]) };
		});
		const ocr = fakeOcr(async () => ({ text: "recovered text", confidence: 0.9 }));
		const extractor = new OcrFallbackPdfExtractor(inner, rasterizer, ocr);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 3 });

		expect(result.pages[1]).toEqual({ number: 2, text: "" });
		expect(result.pages[2]).toEqual({ number: 3, text: "recovered text" });
		expect(result.ocrPages).toEqual([3]);
	});

	it("an OCR engine failure on one page never fails the whole extraction", async () => {
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => {
			throw new Error("worker crashed");
		});
		const extractor = new OcrFallbackPdfExtractor(inner, rasterizer, ocr);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 3 });

		expect(result.pages[1]).toEqual({ number: 2, text: "" });
		expect(result.pages[2]).toEqual({ number: 3, text: "￿￿￿￿￿￿" });
		expect(result.ocrPages).toBeUndefined();
	});

	it("OCR that recovers nothing (still empty/whitespace) leaves the original honest signal untouched", async () => {
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => ({ text: "   ", confidence: 0.1 }));
		const extractor = new OcrFallbackPdfExtractor(inner, rasterizer, ocr);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 3 });

		expect(result.pages[1]).toEqual({ number: 2, text: "" });
		expect(result.ocrPages).toBeUndefined();
	});

	it("bounds OCR to a fixed number of pages per request — extra needy pages are left alone", async () => {
		const manyPages: PdfExtractor = {
			extract: vi.fn().mockResolvedValue({
				totalPages: 6,
				pages: Array.from({ length: 6 }, (_, index) => ({ number: index + 1, text: "" })),
			}),
		};
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => ({ text: "recovered", confidence: 0.9 }));
		const extractor = new OcrFallbackPdfExtractor(manyPages, rasterizer, ocr, 5);

		const result = await extractor.extract(new Uint8Array(), { startPage: 1, endPage: 6 });

		expect(rasterizer.renderPage).toHaveBeenCalledTimes(5);
		expect(result.ocrPages).toEqual([1, 2, 3, 4, 5]);
		expect(result.pages[5]).toEqual({ number: 6, text: "" });
	});
});

describe("PdfContentExtractor with the default OCR-enabled parser", () => {
	it("recovers a genuinely image-only page and flips contentOk to true, reporting ocrPages and a qualityScore", async () => {
		const adapter = new PdfContentExtractor();
		const { page } = await adapter.extract(resource(await fixture("recoverable-scanned.pdf")), {
			view: "full",
			captureImages: false,
			maxImages: 0,
		});

		expect(page.contentOk).toBe(true);
		expect(page.contentWarning).toBeUndefined();
		expect(page.pdf?.ocrPages).toEqual([1]);
		expect(page.pdf?.qualityScore).toBeGreaterThan(0.5);
		expect("markdown" in page ? page.markdown : "").toContain("Recovered by OCR fallback");
	}, 30_000);

	it("keeps an honestly empty scanned page's contentOk:false when OCR also finds nothing", async () => {
		const adapter = new PdfContentExtractor();
		const { page } = await adapter.extract(resource(await fixture("scanned.pdf")), {
			view: "full",
			captureImages: false,
			maxImages: 0,
		});

		expect(page.contentOk).toBe(false);
		expect(page.contentWarning).toBe("no-text-layer");
		expect(page.pdf?.ocrPages).toBeUndefined();
		expect(page.pdf?.qualityScore).toBe(0);
	}, 30_000);

	it("keeps a CID-garbled page's original honest signal when rasterization cannot shape the invalid text, without crashing", async () => {
		const adapter = new PdfContentExtractor();
		const { page } = await adapter.extract(resource(await fixture("cid-garbled.pdf")), {
			view: "full",
			captureImages: false,
			maxImages: 0,
		});

		expect(page.contentOk).toBe(false);
		expect(page.contentWarning).toBe("garbled-text");
		expect(page.pdf?.ocrPages).toBeUndefined();
	}, 30_000);

	it("a normal text-layer PDF never touches the rasterizer/OCR engine at all", async () => {
		const rasterizer = fakeRasterizer(async () => ({ bytes: new Uint8Array([1]) }));
		const ocr = fakeOcr(async () => ({ text: "should never be called", confidence: 1 }));
		const adapter = new PdfContentExtractor(new OcrFallbackPdfExtractor(new UnpdfPdfExtractor(), rasterizer, ocr));

		const { page } = await adapter.extract(resource(await fixture("text.pdf")), {
			view: "full",
			captureImages: false,
			maxImages: 0,
		});

		expect(rasterizer.renderPage).not.toHaveBeenCalled();
		expect(ocr.recognize).not.toHaveBeenCalled();
		expect(page.contentOk).toBe(true);
		expect(page.pdf?.qualityScore).toBe(1);
	});
});

describe("UnpdfPageRasterizer + TesseractOcrEngine — real adapter contract", () => {
	it("renders a real PDF page to a non-empty image", async () => {
		const rasterizer = new UnpdfPageRasterizer();
		const image = await rasterizer.renderPage(await fixture("recoverable-scanned.pdf"), 1);
		expect(image.bytes.byteLength).toBeGreaterThan(0);
	});

	it("recognizes real text from a real rendered image, fully offline", async () => {
		const rasterizer = new UnpdfPageRasterizer();
		const image = await rasterizer.renderPage(await fixture("recoverable-scanned.pdf"), 1);
		const ocr = new TesseractOcrEngine();
		const result = await ocr.recognize(image);
		expect(result.text).toContain("Recovered by OCR fallback");
		expect(result.confidence).toBeGreaterThan(0.5);
	}, 30_000);

	it("rasterizing a page with invalid CID-decoded text throws a clean, catchable error rather than crashing the process", async () => {
		const rasterizer = new UnpdfPageRasterizer();
		await expect(rasterizer.renderPage(await fixture("cid-garbled.pdf"), 1)).rejects.toThrow();
	});
});
