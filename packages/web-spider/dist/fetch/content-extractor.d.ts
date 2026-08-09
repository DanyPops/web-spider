import type { DOMNode, LeanPage, PageView, SpideredPage } from "../types.js";
/** A fetched response presented to content conversion without transport concerns. */
export interface FetchedResource {
    url: string;
    domain: string;
    fetchedAt: string;
    /** Raw response Content-Type header, including parameters when present. */
    contentType: string | null;
    /** Decoded response text when transport supplied a textual representation. */
    text?: string;
    /** Original bytes when an adapter needs binary input (for example, a PDF extractor). */
    bytes?: Uint8Array;
}
/** Conversion options that do not grant an extractor network or cache access. */
export interface ContentExtractionOptions {
    view: PageView;
    rootSelector?: string;
    excludeSelectors?: string;
    tokenBudget?: number;
    /** 1-based inclusive PDF page range; ignored by non-PDF Strategies. */
    pdfPageStart?: number;
    /** 1-based inclusive PDF page range; ignored by non-PDF Strategies. */
    pdfPageEnd?: number;
    captureImages: boolean;
    maxImages: number;
}
/** An image discovered during pure extraction; spider() performs optional hydration. */
export interface ExtractedImageCandidate {
    src: string;
    alt: string;
}
/** A page with its full semantic tree attached. */
export interface TreePage extends SpideredPage {
    readonly view: "tree";
    tree: DOMNode;
}
export type ExtractedPage = SpideredPage | LeanPage | TreePage;
export interface ContentExtractionResult {
    page: ExtractedPage;
    imageCandidates?: readonly ExtractedImageCandidate[];
}
/**
 * Pure response-content Strategy. Implementations classify and convert one
 * already-fetched resource; they never perform network, cache, or robots I/O.
 */
export interface ContentExtractor {
    supports(resource: FetchedResource): boolean;
    extract(resource: FetchedResource, options: ContentExtractionOptions): Promise<ContentExtractionResult>;
}
/** Select the first caller-provided Strategy that supports the resource, then fall back to built-ins. */
export declare function extractFetchedResource(resource: FetchedResource, options: ContentExtractionOptions, customExtractors?: readonly ContentExtractor[]): Promise<ContentExtractionResult>;
//# sourceMappingURL=content-extractor.d.ts.map