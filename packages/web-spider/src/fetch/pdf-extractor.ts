import { chunk } from "../extract/convert.js";
import type { DOMNode, LeanPage, SpideredPage } from "../types.js";
import type {
	ContentExtractionOptions,
	ContentExtractionResult,
	ContentExtractor,
	FetchedResource,
	TreePage,
} from "./content-extractor.js";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES_PER_REQUEST = 50;
const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const MAX_PDF_OUTLINE_ENTRIES = 50;
const MAX_PDF_OUTLINE_DEPTH = 3;
const WORDS_PER_MINUTE = 200;

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
}

/** Narrow parser port. Third-party PDF.js objects never cross this boundary. */
export interface PdfExtractor {
	extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction>;
}

export class PdfExtractionError extends Error {
	readonly code = "pdf-extraction-failed" as const;

	constructor(message = "PDF extraction failed: invalid or unsupported PDF") {
		super(message);
		this.name = "PdfExtractionError";
	}
}

interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
}

interface PdfOutlineNode {
	title?: string;
	dest?: unknown;
	items?: PdfOutlineNode[];
}

function optionalMetadataValue(info: Record<string, unknown>, key: string): string | undefined {
	const value = info[key];
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

async function outlinePage(
	document: {
		getDestination(name: string): Promise<unknown[] | null>;
		getPageIndex(reference: unknown): Promise<number>;
	},
	node: PdfOutlineNode,
): Promise<number | undefined> {
	try {
		let destination = node.dest;
		if (typeof destination === "string") destination = await document.getDestination(destination);
		if (!Array.isArray(destination) || destination.length === 0) return undefined;
		return (await document.getPageIndex(destination[0])) + 1;
	} catch {
		return undefined;
	}
}

async function normalizeOutline(
	document: {
		getDestination(name: string): Promise<unknown[] | null>;
		getPageIndex(reference: unknown): Promise<number>;
	},
	nodes: PdfOutlineNode[] | null,
): Promise<PdfOutlineEntry[]> {
	const result: PdfOutlineEntry[] = [];
	async function visit(items: PdfOutlineNode[], level: 1 | 2 | 3): Promise<void> {
		for (const item of items) {
			if (result.length >= MAX_PDF_OUTLINE_ENTRIES) return;
			const title = item.title?.trim();
			if (title) {
				const page = await outlinePage(document, item);
				result.push({ title, level, ...(page !== undefined ? { page } : {}) });
			}
			if (item.items?.length && level < MAX_PDF_OUTLINE_DEPTH) {
				await visit(item.items, (level + 1) as 2 | 3);
			}
		}
	}
	await visit(nodes ?? [], 1);
	return result;
}

/** Production Adapter around unpdf's bundled serverless PDF.js build. */
export class UnpdfPdfExtractor implements PdfExtractor {
	async extract(bytes: Uint8Array, range: PdfPageRange): Promise<PdfExtraction> {
		try {
			const { getDocumentProxy } = await import("unpdf");
			const document = await getDocumentProxy(bytes, {
				maxImageSize: MAX_PDF_IMAGE_PIXELS,
				// Keep third-party parser diagnostics out of agent/daemon stderr.
				verbosity: 0,
			});
			try {
				if (range.startPage > document.numPages) {
					throw new PdfExtractionError(`PDF page range starts at ${range.startPage}, but the document has ${document.numPages} pages`);
				}
				const endPage = Math.min(range.endPage, document.numPages);
				const pages: PdfExtractedPage[] = [];
				for (let pageNumber = range.startPage; pageNumber <= endPage; pageNumber++) {
					const page = await document.getPage(pageNumber);
					const content = await page.getTextContent();
					const text = (content.items as PdfTextItem[])
						.filter((item) => item.str !== undefined)
						.map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : ""}`)
						.join("");
					pages.push({ number: pageNumber, text });
				}

				const rawMetadata = await document.getMetadata().catch(() => undefined);
				const info = (rawMetadata?.info ?? {}) as Record<string, unknown>;
				const metadata: PdfMetadata = {
					title: optionalMetadataValue(info, "Title"),
					author: optionalMetadataValue(info, "Author"),
					subject: optionalMetadataValue(info, "Subject"),
					keywords: optionalMetadataValue(info, "Keywords"),
					creator: optionalMetadataValue(info, "Creator"),
					producer: optionalMetadataValue(info, "Producer"),
				};
				const outline = await normalizeOutline(document, await document.getOutline().catch(() => null));
				return {
					totalPages: document.numPages,
					pages,
					...(outline.length > 0 ? { outline } : {}),
					...(Object.values(metadata).some(Boolean) ? { metadata } : {}),
				};
			} finally {
				await document.cleanup();
			}
		} catch (error) {
			if (error instanceof PdfExtractionError) throw error;
			throw new PdfExtractionError();
		}
	}
}

function normalizedMediaType(contentType: string | null): string {
	return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function hasPdfHeader(bytes: Uint8Array | undefined): boolean {
	if (!bytes) return false;
	const probe = bytes.subarray(0, Math.min(bytes.length, 1024));
	return new TextDecoder("latin1").decode(probe).includes("%PDF-");
}

function normalizeRange(options: ContentExtractionOptions): PdfPageRange {
	const startPage = options.pdfPageStart ?? 1;
	const endPage = options.pdfPageEnd ?? startPage + MAX_PDF_PAGES_PER_REQUEST - 1;
	if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
		throw new Error("PDF page range must use positive 1-based integers with pdfPageEnd >= pdfPageStart");
	}
	if (endPage - startPage + 1 > MAX_PDF_PAGES_PER_REQUEST) {
		throw new Error(`PDF page range cannot exceed ${MAX_PDF_PAGES_PER_REQUEST} pages`);
	}
	return { startPage, endPage };
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname);
	} catch {
		return url;
	}
}

function invalidGlyphRatio(text: string): number {
	const visible = [...text].filter((character) => !/\s/u.test(character));
	if (visible.length === 0) return 0;
	const invalid = visible.filter((character) => /[\uFFFD\uFFFF\uE000-\uF8FF]/u.test(character)).length;
	return invalid / visible.length;
}

function qualityOf(text: string): { contentOk: boolean; contentWarning?: "no-text-layer" | "garbled-text" } {
	if (!text.trim()) return { contentOk: false, contentWarning: "no-text-layer" };
	if (invalidGlyphRatio(text) >= 0.2) return { contentOk: false, contentWarning: "garbled-text" };
	return { contentOk: true };
}

function outlineMarkdown(outline: readonly PdfOutlineEntry[]): string {
	if (outline.length === 0) return "";
	const entries = outline.map((item) => {
		const suffix = item.page !== undefined ? ` — page ${item.page}` : "";
		return `${"  ".repeat(item.level - 1)}- ${item.title}${suffix}`;
	});
	return `## Table of Contents\n\n${entries.join("\n")}\n\n`;
}

function pagesMarkdown(pages: readonly PdfExtractedPage[]): string {
	return pages.map((page) => `--- Page ${page.number} ---\n\n${page.text.trim()}`).join("\n\n");
}

function boundedText(text: string, tokenBudget: number | undefined): string {
	if (tokenBudget === undefined) return text;
	return text.slice(0, Math.max(0, Math.floor(tokenBudget * 4)));
}

function boundedTree(pages: readonly PdfExtractedPage[], tokenBudget: number | undefined): DOMNode {
	let remaining = tokenBudget === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(tokenBudget * 4));
	const children = pages.map((page, index) => {
		const text = page.text.trim().slice(0, remaining);
		remaining -= text.length;
		return { tag: "page", path: `pdf.page[${index}]`, text };
	});
	return { tag: "pdf", path: "pdf", children };
}

/** Content Strategy that normalizes the narrow PdfExtractor result into Web Spider pages. */
export class PdfContentExtractor implements ContentExtractor {
	constructor(private readonly parser: PdfExtractor = new UnpdfPdfExtractor()) {}

	supports(resource: FetchedResource): boolean {
		return normalizedMediaType(resource.contentType) === "application/pdf" || hasPdfHeader(resource.bytes);
	}

	async extract(resource: FetchedResource, options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const bytes = resource.bytes;
		if (!bytes) throw new PdfExtractionError("PDF extraction failed: response bytes were unavailable");
		if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfExtractionError("PDF exceeds the 20 MiB extraction limit");
		const range = normalizeRange(options);
		const extracted = await this.parser.extract(bytes, range);
		const pageStart = extracted.pages[0]?.number ?? range.startPage;
		const pageEnd = extracted.pages.at(-1)?.number ?? pageStart;
		const outline = (extracted.outline ?? []).filter((item) => item.page === undefined || (item.page >= pageStart && item.page <= pageEnd));
		const fullMarkdown = `${outlineMarkdown(outline)}${pagesMarkdown(extracted.pages)}`;
		const markdown = boundedText(fullMarkdown, options.tokenBudget);
		const fullText = extracted.pages.map((page) => page.text).join("\n");
		const quality = qualityOf(fullText);
		const wordCount = fullText.split(/\s+/u).filter(Boolean).length;
		const metadata = extracted.metadata ?? {};
		const pdf = {
			totalPages: extracted.totalPages,
			pageStart,
			pageEnd,
			truncated: pageEnd < extracted.totalPages || pageStart > 1,
		};
		const identity = {
			url: resource.url,
			domain: resource.domain,
			fetchedAt: resource.fetchedAt,
			title: metadata.title ?? titleFromUrl(resource.url),
			description: metadata.subject ?? "",
			author: metadata.author ?? "",
			publishedAt: "",
			lang: "",
			tags: metadata.keywords
				? metadata.keywords
						.split(/[,;]/u)
						.map((tag) => tag.trim())
						.filter(Boolean)
				: [],
			headings: outline.map((item) => ({ level: item.level, text: item.title })),
			links: [],
			contentType: "application/pdf",
			contentOk: quality.contentOk,
			...(quality.contentWarning ? { contentWarning: quality.contentWarning } : {}),
			pdf,
		};

		if (options.view === "lean") {
			const page: LeanPage = {
				...identity,
				view: "lean",
				wordCount,
				readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
				chunkCount: Math.max(0, Math.floor(wordCount / 150)),
				headings: outline.map((item) => `${"#".repeat(item.level)} ${item.title}`),
			};
			return { page };
		}

		const base: SpideredPage = {
			...identity,
			wordCount,
			readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
			chunks: chunk(markdown, resource.url),
			markdown,
		};
		if (options.view === "tree") {
			const page: TreePage = { ...base, view: "tree", tree: boundedTree(extracted.pages, options.tokenBudget) };
			return { page };
		}
		return { page: base };
	}
}
