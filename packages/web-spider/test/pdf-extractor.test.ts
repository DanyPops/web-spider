import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ContentExtractionOptions, FetchedResource } from "../src/fetch/content-extractor.js";
import {
	extractFetchedResource,
	type IHttpClient,
	PdfContentExtractor,
	type PdfExtractionError,
	type PdfExtractor,
	spider,
	UnpdfPdfExtractor,
} from "../src/index.js";

const FIXTURES = new URL("./fixtures/pdf/", import.meta.url);

function resource(bytes: Uint8Array, contentType: string | null = "application/pdf"): FetchedResource {
	return {
		url: "https://example.com/reports/guide.pdf",
		domain: "example.com",
		fetchedAt: "2026-08-09T00:00:00.000Z",
		contentType,
		bytes,
	};
}

function options(overrides: Partial<ContentExtractionOptions> = {}): ContentExtractionOptions {
	return {
		view: "full",
		captureImages: false,
		maxImages: 0,
		...overrides,
	};
}

async function fixture(name: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

describe("PdfContentExtractor Strategy", () => {
	it("detects PDFs by media type or a PDF header in the first 1,024 bytes", () => {
		const adapter = new PdfContentExtractor({ extract: vi.fn() });
		expect(adapter.supports(resource(new Uint8Array(), "application/pdf; charset=binary"))).toBe(true);
		expect(adapter.supports(resource(new TextEncoder().encode("prefix\n%PDF-1.7\n"), "application/octet-stream"))).toBe(true);
		expect(adapter.supports(resource(new TextEncoder().encode("plain text"), "application/octet-stream"))).toBe(false);
	});

	it("uses an injected narrow PdfExtractor and normalizes selected pages, outline, and metadata", async () => {
		const extract = vi.fn<PdfExtractor["extract"]>().mockResolvedValue({
			totalPages: 8,
			pages: [
				{ number: 2, text: "Second page" },
				{ number: 3, text: "Third page" },
			],
			outline: [{ title: "Methods", page: 2, level: 1 }],
			metadata: { title: "Fixture Guide", author: "Ada Example", subject: "Testing" },
		});
		const adapter = new PdfContentExtractor({ extract });
		const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
		const result = await adapter.extract(resource(bytes), options({ pdfPageStart: 2, pdfPageEnd: 3 }));

		expect(extract).toHaveBeenCalledWith(bytes, { startPage: 2, endPage: 3 });
		expect(result.page).toMatchObject({
			url: "https://example.com/reports/guide.pdf",
			title: "Fixture Guide",
			author: "Ada Example",
			description: "Testing",
			contentType: "application/pdf",
			contentOk: true,
			pdf: { totalPages: 8, pageStart: 2, pageEnd: 3, truncated: true },
			headings: [{ level: 1, text: "Methods" }],
		});
		expect("markdown" in result.page ? result.page.markdown : "").toBe(
			"## Table of Contents\n\n- Methods — page 2\n\n--- Page 2 ---\n\nSecond page\n\n--- Page 3 ---\n\nThird page",
		);
	});

	it("defaults to a bounded first-50-page range and rejects invalid or oversized ranges before parser entry", async () => {
		const extract = vi.fn<PdfExtractor["extract"]>().mockResolvedValue({
			totalPages: 1,
			pages: [{ number: 1, text: "ok" }],
		});
		const adapter = new PdfContentExtractor({ extract });
		await adapter.extract(resource(await fixture("text.pdf")), options());
		expect(extract).toHaveBeenLastCalledWith(expect.any(Uint8Array), { startPage: 1, endPage: 50 });

		for (const range of [
			{ pdfPageStart: 0 },
			{ pdfPageStart: 3, pdfPageEnd: 2 },
			{ pdfPageStart: 1, pdfPageEnd: 51 },
			{ pdfPageStart: 1.5 },
		]) {
			await expect(adapter.extract(resource(await fixture("text.pdf")), options(range))).rejects.toThrow(/PDF page range/i);
		}
		expect(extract).toHaveBeenCalledTimes(1);
	});

	it("rejects parser input larger than the fixed PDF byte limit", async () => {
		const adapter = new PdfContentExtractor({ extract: vi.fn() });
		await expect(adapter.extract(resource(new Uint8Array(20 * 1024 * 1024 + 1)), options())).rejects.toThrow(
			/PDF exceeds the 20 MiB extraction limit/i,
		);
	});

	it("reports an empty/image-only text layer honestly", async () => {
		const adapter = new PdfContentExtractor({
			extract: vi.fn().mockResolvedValue({ totalPages: 1, pages: [{ number: 1, text: "" }] }),
		});
		const { page } = await adapter.extract(resource(await fixture("scanned.pdf")), options());
		expect(page).toMatchObject({ contentOk: false, contentWarning: "no-text-layer", wordCount: 0 });
		expect("markdown" in page ? page.markdown : "").toContain("--- Page 1 ---");
	});

	it("reports CID/replacement/private-use dominated output honestly", async () => {
		const adapter = new PdfContentExtractor({
			extract: vi.fn().mockResolvedValue({ totalPages: 1, pages: [{ number: 1, text: "￿￿￿￿" }] }),
		});
		const { page } = await adapter.extract(resource(await fixture("cid-garbled.pdf")), options());
		expect(page).toMatchObject({ contentOk: false, contentWarning: "garbled-text" });
	});

	it("applies token budgets to normalized PDF markdown", async () => {
		const adapter = new PdfContentExtractor({
			extract: vi.fn().mockResolvedValue({ totalPages: 1, pages: [{ number: 1, text: "x".repeat(200) }] }),
		});
		const { page } = await adapter.extract(resource(await fixture("text.pdf")), options({ tokenBudget: 10 }));
		expect("markdown" in page ? page.markdown.length : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(40);
	});

	it("is selected through the built-in response-content Strategy registry", async () => {
		const { page } = await extractFetchedResource(resource(await fixture("text.pdf")), options());
		expect(page).toMatchObject({ contentType: "application/pdf", contentOk: true, pdf: { totalPages: 1 } });
		expect("markdown" in page ? page.markdown : "").toContain("Hello, world!");
	});

	it("receives original bytes from spider transport and detects a mislabelled PDF by magic", async () => {
		const bytes = await fixture("multi-page.pdf");
		let accept = "";
		const httpClient: IHttpClient = {
			async fetch(request) {
				accept = request.headers?.Accept ?? "";
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/octet-stream" : null) },
					text: async () => {
						throw new Error("binary response must not use text() as its primary body read");
					},
					arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
				};
			},
		};
		const page = await spider("https://example.com/report.bin", { httpClient, pdfPageStart: 2, pdfPageEnd: 2 });
		expect(accept).toContain("application/pdf");
		expect(page).toMatchObject({ contentType: "application/pdf", pdf: { totalPages: 3, pageStart: 2, pageEnd: 2 } });
		expect(page.markdown).toContain("--- Page 2 ---");
		expect(page.markdown).not.toContain("--- Page 1 ---");
	});
});

describe("UnpdfPdfExtractor fixture contract", () => {
	const adapter = new UnpdfPdfExtractor();

	it("extracts a normal text layer", async () => {
		await expect(adapter.extract(await fixture("text.pdf"), { startPage: 1, endPage: 1 })).resolves.toMatchObject({
			totalPages: 1,
			pages: [{ number: 1, text: "Hello, world!" }],
		});
	});

	it("extracts only the bounded requested pages from a multi-page PDF", async () => {
		await expect(adapter.extract(await fixture("multi-page.pdf"), { startPage: 2, endPage: 3 })).resolves.toMatchObject({
			totalPages: 3,
			pages: [
				{ number: 2, text: "2" },
				{ number: 3, text: "3" },
			],
		});
	});

	it("normalizes a real nested outline to a bounded three-level table of contents", async () => {
		const result = await adapter.extract(await fixture("outline.pdf"), { startPage: 1, endPage: 9 });
		expect(result.outline?.slice(0, 3)).toEqual([
			{ title: "1. Introduction", page: 1, level: 1 },
			{ title: "1.1 Background", page: 2, level: 2 },
			{ title: "1.2 Motivation", page: 3, level: 2 },
		]);
		expect(result.outline?.length).toBeLessThanOrEqual(50);
	});

	it("returns an empty page for a scanned/image-only PDF instead of claiming OCR", async () => {
		await expect(adapter.extract(await fixture("scanned.pdf"), { startPage: 1, endPage: 1 })).resolves.toMatchObject({
			totalPages: 1,
			pages: [{ number: 1, text: "" }],
		});
	});

	it("returns CID output for the quality boundary to classify", async () => {
		const result = await adapter.extract(await fixture("cid-garbled.pdf"), { startPage: 1, endPage: 1 });
		expect(result.pages[0]?.text).toMatch(/￿/u);
	});

	it("maps malformed files and arbitrary third-party failures to a stable core error", async () => {
		await expect(adapter.extract(await fixture("malformed.pdf"), { startPage: 1, endPage: 1 })).rejects.toEqual(
			expect.objectContaining<PdfExtractionError>({
				name: "PdfExtractionError",
				code: "pdf-extraction-failed",
				message: "PDF extraction failed: invalid or unsupported PDF",
			}),
		);
	});
});
