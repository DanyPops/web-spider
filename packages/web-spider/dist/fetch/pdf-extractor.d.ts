import type { ContentExtractionOptions, ContentExtractionResult, ContentExtractor, FetchedResource } from "./content-extractor.js";
export interface PdfPageRange {
    /** 1-based inclusive first page. */
    startPage: number;
    /** 1-based inclusive last page. */
    endPage: number;
}
export interface PdfExtractedPage {
    number: number;
    text: string;
}
export interface PdfOutlineEntry {
    title: string;
    page?: number;
    level: 1 | 2 | 3;
}
export interface PdfMetadata {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
}
export interface PdfExtraction {
    totalPages: number;
    pages: PdfExtractedPage[];
    outline?: PdfOutlineEntry[];
    metadata?: PdfMetadata;
    /** Page numbers whose text was recovered by an OCR fallback (see pdf-ocr.ts), if any. */
    ocrPages?: number[];
}
/** Narrow parser port. Third-party PDF.js objects never cross this boundary. */
export interface PdfExtractor {
    extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction>;
}
export declare class PdfExtractionError extends Error {
    readonly code: "pdf-extraction-failed";
    constructor(message?: string);
}
/** Production Adapter around unpdf's bundled serverless PDF.js build. */
export declare class UnpdfPdfExtractor implements PdfExtractor {
    extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction>;
}
/** True when a page's text is empty or dominated by invalid/replacement glyphs — the OCR fallback's trigger. */
export declare function pageNeedsOcr(text: string): boolean;
/** Content Strategy that normalizes the narrow PdfExtractor result into Web Spider pages. */
export declare class PdfContentExtractor implements ContentExtractor {
    private readonly parser;
    constructor(parser?: PdfExtractor);
    supports(resource: FetchedResource): boolean;
    extract(resource: FetchedResource, options: ContentExtractionOptions): Promise<ContentExtractionResult>;
}
//# sourceMappingURL=pdf-extractor.d.ts.map