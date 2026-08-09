import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageNeedsOcr } from "./pdf-extractor.js";
const DEFAULT_MAX_OCR_PAGES_PER_REQUEST = 5;
const OCR_RENDER_SCALE = 2.0;
const DEFAULT_OCR_CACHE_PATH = join(tmpdir(), "web-spider-pdf-ocr-cache");
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
export class UnpdfPageRasterizer {
    async renderPage(bytes, pageNumber) {
        const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
        const document = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
        try {
            const buffer = await renderPageAsImage(document, pageNumber, {
                scale: OCR_RENDER_SCALE,
                canvasImport: () => import("@napi-rs/canvas"),
            });
            return { bytes: new Uint8Array(buffer) };
        }
        finally {
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
export class TesseractOcrEngine {
    constructor(cachePath = DEFAULT_OCR_CACHE_PATH) {
        this.cachePath = cachePath;
    }
    async recognize(image) {
        const [{ createWorker }, { default: engData }] = await Promise.all([import("tesseract.js"), import("@tesseract.js-data/eng")]);
        const worker = await createWorker("eng", 1, {
            langPath: engData.langPath,
            gzip: engData.gzip,
            cachePath: this.cachePath,
            logger: () => { },
        });
        try {
            const { data } = await worker.recognize(Buffer.from(image.bytes));
            return { text: data.text, confidence: Math.max(0, Math.min(1, data.confidence / 100)) };
        }
        finally {
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
export class OcrFallbackPdfExtractor {
    constructor(inner, rasterizer, ocr, maxOcrPages = DEFAULT_MAX_OCR_PAGES_PER_REQUEST) {
        this.inner = inner;
        this.rasterizer = rasterizer;
        this.ocr = ocr;
        this.maxOcrPages = maxOcrPages;
    }
    async extract(bytes, range) {
        // Preserved before delegating: the inner extractor's own PDF.js document load
        // detaches its input ArrayBuffer as a side effect (structured-clone transfer
        // semantics -- see docs/pdf-ocr-fallback.md), so `bytes` itself is unusable by
        // the time we might need to rasterize a page from it.
        const bytesForOcr = bytes.slice();
        const result = await this.inner.extract(bytes, range);
        const ocrPages = [];
        let budget = this.maxOcrPages;
        const pages = [];
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
    async tryRecover(bytes, pageNumber) {
        try {
            const image = await this.rasterizer.renderPage(bytes, pageNumber);
            const { text } = await this.ocr.recognize(image);
            return text;
        }
        catch {
            return undefined;
        }
    }
}
//# sourceMappingURL=pdf-ocr.js.map