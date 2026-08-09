import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PdfExtractedPage, PdfExtraction, PdfExtractor, PdfPageRange } from "./pdf-extractor.js";
import { pageNeedsOcr } from "./pdf-extractor.js";

const DEFAULT_MAX_OCR_PAGES_PER_REQUEST = 5;
const OCR_RENDER_SCALE = 2.0;
const DEFAULT_OCR_CACHE_PATH = join(tmpdir(), "web-spider-pdf-ocr-cache");

/** A single rendered page image, ready for OCR. Never a third-party canvas/bitmap object. */
export interface PdfPageImage {
	readonly bytes: Uint8Array;
}

/** Narrow rasterization port. Third-party PDF.js/canvas objects never cross this boundary. */
export interface PdfPageRasterizer {
	renderPage(bytes: Uint8Array, pageNumber: number): Promise<PdfPageImage>;
}

export interface OcrResult {
	readonly text: string;
	/** 0.0-1.0 engine-reported confidence. */
	readonly confidence: number;
}

/** Narrow OCR port. Third-party OCR engine/worker objects never cross this boundary. */
export interface OcrEngine {
	recognize(image: PdfPageImage): Promise<OcrResult>;
}

/**
 * Production Adapter: renders a PDF page to a PNG image via unpdf's bundled PDF.js.
 *
 * Always hands PDF.js a *fresh copy* of the input bytes: PDF.js's Node message
 * transport moves document data to its (simulated, in-process) worker using
 * structured-clone transfer semantics, which detaches the original ArrayBuffer as a
 * side effect. Without copying, a second document load or render sharing the same
 * underlying buffer as an earlier call -- e.g. the inner text extractor and this
 * rasterizer both operating on one fetched PDF's bytes -- silently sees a zero-length
 * buffer. This was verified empirically; see docs/pdf-ocr-fallback.md.
 */
export class UnpdfPageRasterizer implements PdfPageRasterizer {
	async renderPage(bytes: Uint8Array, pageNumber: number): Promise<PdfPageImage> {
		const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
		const document = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
		try {
			const buffer = await renderPageAsImage(document, pageNumber, {
				scale: OCR_RENDER_SCALE,
				canvasImport: () => import("@napi-rs/canvas"),
			});
			return { bytes: new Uint8Array(buffer) };
		} finally {
			await document.cleanup();
		}
	}
}

/**
 * Production Adapter: pure JS/WASM OCR via tesseract.js. Fully offline -- uses
 * @tesseract.js-data/eng's bundled English model rather than tesseract.js's default
 * CDN download, and a stable cachePath (outside process cwd) so the one-time
 * gzip decompression is reused across calls instead of repeated per request.
 */
export class TesseractOcrEngine implements OcrEngine {
	constructor(private readonly cachePath: string = DEFAULT_OCR_CACHE_PATH) {}

	async recognize(image: PdfPageImage): Promise<OcrResult> {
		const [{ createWorker }, { default: engData }] = await Promise.all([import("tesseract.js"), import("@tesseract.js-data/eng")]);
		const worker = await createWorker("eng", 1, {
			langPath: engData.langPath,
			gzip: engData.gzip,
			cachePath: this.cachePath,
			logger: () => {},
		});
		try {
			const { data } = await worker.recognize(Buffer.from(image.bytes));
			return { text: data.text, confidence: Math.max(0, Math.min(1, data.confidence / 100)) };
		} finally {
			await worker.terminate();
		}
	}
}

/**
 * Decorator: wraps a PdfExtractor and recovers empty/garbled pages via OCR.
 *
 * Bounded to maxOcrPages per request -- OCR is a slow fallback path, not the common case.
 * A per-page rasterize/recognize failure (e.g. a canvas renderer unable to shape invalid
 * CID-decoded text -- see docs/pdf-ocr-fallback.md) is caught and leaves that page's
 * original, already-honest text/quality signal untouched; it never fails the whole
 * extraction.
 */
export class OcrFallbackPdfExtractor implements PdfExtractor {
	constructor(
		private readonly inner: PdfExtractor,
		private readonly rasterizer: PdfPageRasterizer,
		private readonly ocr: OcrEngine,
		private readonly maxOcrPages: number = DEFAULT_MAX_OCR_PAGES_PER_REQUEST,
	) {}

	async extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction> {
		// Preserved before delegating: the inner extractor's own PDF.js document load
		// detaches its input ArrayBuffer as a side effect (structured-clone transfer
		// semantics -- see docs/pdf-ocr-fallback.md), so `bytes` itself is unusable by
		// the time we might need to rasterize a page from it.
		const bytesForOcr = bytes.slice();
		const result = await this.inner.extract(bytes, range);
		const ocrPages: number[] = [];
		let budget = this.maxOcrPages;
		const pages: PdfExtractedPage[] = [];
		for (const page of result.pages) {
			if (budget > 0 && pageNeedsOcr(page.text)) {
				budget--;
				const recovered = await this.tryRecover(bytesForOcr, page.number);
				if (recovered?.trim()) {
					pages.push({ ...page, text: recovered });
					ocrPages.push(page.number);
					continue;
				}
			}
			pages.push(page);
		}
		return { ...result, pages, ...(ocrPages.length > 0 ? { ocrPages } : {}) };
	}

	private async tryRecover(bytes: Uint8Array, pageNumber: number): Promise<string | undefined> {
		try {
			const image = await this.rasterizer.renderPage(bytes, pageNumber);
			const { text } = await this.ocr.recognize(image);
			return text;
		} catch {
			return undefined;
		}
	}
}
