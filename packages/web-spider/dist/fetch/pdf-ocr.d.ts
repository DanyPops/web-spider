import type { PdfExtraction, PdfExtractor, PdfPageRange } from "./pdf-extractor.js";
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
export declare class UnpdfPageRasterizer implements PdfPageRasterizer {
    renderPage(bytes: Uint8Array, pageNumber: number): Promise<PdfPageImage>;
}
/**
 * Production Adapter: pure JS/WASM OCR via tesseract.js. Fully offline -- uses
 * @tesseract.js-data/eng's bundled English model rather than tesseract.js's default
 * CDN download, and a stable cachePath (outside process cwd) so the one-time
 * gzip decompression is reused across calls instead of repeated per request.
 */
export declare class TesseractOcrEngine implements OcrEngine {
    private readonly cachePath;
    constructor(cachePath?: string);
    recognize(image: PdfPageImage): Promise<OcrResult>;
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
export declare class OcrFallbackPdfExtractor implements PdfExtractor {
    private readonly inner;
    private readonly rasterizer;
    private readonly ocr;
    private readonly maxOcrPages;
    constructor(inner: PdfExtractor, rasterizer: PdfPageRasterizer, ocr: OcrEngine, maxOcrPages?: number);
    extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction>;
    private tryRecover;
}
//# sourceMappingURL=pdf-ocr.d.ts.map