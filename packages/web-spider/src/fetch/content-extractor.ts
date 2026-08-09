import { Readability } from "@mozilla/readability";
import { chunk, toMarkdown } from "../extract/convert.js";
import { extractCanonicalUrl, extractHeadings, extractLinks, extractTags, parseDom } from "../extract/parse.js";
import { buildTree } from "../extract/tree.js";
import { toLean } from "../extract/views.js";
import type { DOMNode, LeanPage, PageView, SpideredPage } from "../types.js";
import { classifyContentType } from "./content-type.js";
import { PdfContentExtractor } from "./pdf-extractor.js";

const WORDS_PER_MINUTE = 200;

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

function requireText(resource: FetchedResource): string {
	if (resource.text === undefined) {
		throw new Error(`Cannot extract textual content from "${resource.url}" — the response body was not decoded as text`);
	}
	return resource.text;
}

/** Pretty-prints parseable JSON and leaves invalid JSON/JSONL unchanged. */
function prettyPrintIfJson(rawText: string): string {
	try {
		return JSON.stringify(JSON.parse(rawText), null, 2);
	} catch {
		return rawText;
	}
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
	} catch {
		return url;
	}
}

function extractMarkdownHeadings(text: string): SpideredPage["headings"] {
	const headings: SpideredPage["headings"] = [];
	for (const line of text.split("\n")) {
		const match = /^(#{1,3})\s+(.+)/.exec(line.trim());
		if (match) headings.push({ level: match[1].length as 1 | 2 | 3, text: match[2].trim() });
	}
	return headings;
}

function extractImageCandidates(articleHtml: string, pageUrl: string, maxImages: number): ExtractedImageCandidate[] {
	const doc = parseDom(articleHtml, pageUrl);
	const candidates: ExtractedImageCandidate[] = [];
	for (const element of [...doc.querySelectorAll("img")].slice(0, maxImages)) {
		const rawSrc = element.getAttribute("src") ?? "";
		if (!rawSrc) continue;
		if (rawSrc.startsWith("data:")) {
			candidates.push({ src: rawSrc, alt: element.getAttribute("alt") ?? "" });
			continue;
		}
		try {
			candidates.push({ src: new URL(rawSrc, pageUrl).toString(), alt: element.getAttribute("alt") ?? "" });
		} catch {
			// Invalid image references are not extraction candidates.
		}
	}
	return candidates;
}

const textualExtractor: ContentExtractor = {
	supports(resource) {
		return ["text", "json", "xml"].includes(classifyContentType(resource.contentType));
	},
	async extract(resource, options) {
		const rawText = requireText(resource);
		const text = classifyContentType(resource.contentType) === "json" ? prettyPrintIfJson(rawText) : rawText;
		const wordCount = text.split(/\s+/).filter(Boolean).length;
		const headings = extractMarkdownHeadings(text);
		const title = titleFromUrl(resource.url);
		const readingTimeMinutes = Math.ceil(wordCount / WORDS_PER_MINUTE);
		const contentTypeField = resource.contentType ? { contentType: resource.contentType } : {};

		if (options.view === "lean") {
			return {
				page: {
					view: "lean",
					url: resource.url,
					domain: resource.domain,
					fetchedAt: resource.fetchedAt,
					title,
					lang: "",
					tags: [],
					wordCount,
					readingTimeMinutes,
					chunkCount: Math.max(0, Math.floor(wordCount / 150)),
					headings: headings.map((heading) => `${"#".repeat(heading.level)} ${heading.text}`),
					links: [],
					...contentTypeField,
				},
			};
		}

		const chunks = chunk(text, resource.url);
		const base = {
			url: resource.url,
			domain: resource.domain,
			fetchedAt: resource.fetchedAt,
			title,
			description: "",
			author: "",
			publishedAt: "",
			lang: "",
			tags: [],
			wordCount,
			readingTimeMinutes,
			headings,
			chunks,
			links: [],
			markdown: text,
			...contentTypeField,
		};

		if (options.view === "tree") {
			return { page: { ...base, view: "tree", tree: { tag: "text", path: "text", text } } };
		}
		return { page: base };
	},
};

const htmlExtractor: ContentExtractor = {
	supports(resource) {
		return classifyContentType(resource.contentType) === "html";
	},
	async extract(resource, options) {
		const html = requireText(resource);
		const doc = parseDom(html, resource.url);

		if (options.excludeSelectors) {
			for (const selector of options.excludeSelectors
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean)) {
				for (const element of [...doc.querySelectorAll(selector)]) element.remove();
			}
		}

		if (options.rootSelector) {
			const root = doc.querySelector(options.rootSelector);
			if (root) doc.body.innerHTML = root.outerHTML;
		}

		const links = extractLinks(doc, resource.url);
		const canonicalUrl = extractCanonicalUrl(doc, resource.url);
		const readabilityResult = new Readability(doc).parse();
		const jsRendered = !readabilityResult;
		const article = readabilityResult ?? {
			title: (doc.querySelector("title")?.textContent ?? "").trim(),
			content: "",
			textContent: "",
			length: 0,
			excerpt: "",
			byline: "",
			dir: "",
			site_name: "",
			lang: "",
			publishedTime: null,
			readingTimeMinutes: 0,
		};
		const meta = (name: string): string => {
			const element =
				doc.querySelector(`meta[name="${name}"]`) ??
				doc.querySelector(`meta[property="og:${name}"]`) ??
				doc.querySelector(`meta[property="${name}"]`);
			return (element?.getAttribute("content") ?? "").trim();
		};
		const headings = extractHeadings(article.content ?? "");
		const tags = extractTags(doc);
		const identity = {
			url: resource.url,
			domain: resource.domain,
			fetchedAt: resource.fetchedAt,
			...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
			title: article.title ?? meta("title"),
			description: meta("description"),
			author: article.byline ?? meta("author"),
			publishedAt: meta("article:published_time") ?? meta("date"),
			lang: doc.documentElement?.lang ?? "en",
			tags,
			headings,
			links,
		};

		if (options.view === "lean") {
			const textContent = (article.textContent ?? "").trim();
			const wordCount = textContent.split(/\s+/).filter(Boolean).length;
			const full = {
				...identity,
				wordCount,
				readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
				chunks: [],
				markdown: "",
			} satisfies SpideredPage;
			return {
				page: { ...toLean(full), chunkCount: Math.max(0, Math.floor(wordCount / 150)), ...(jsRendered ? { jsRendered: true } : {}) },
			};
		}

		const markdown = toMarkdown(article.content ?? "", { keepImages: options.captureImages });
		const wordCount = markdown.split(/\s+/).filter(Boolean).length;
		const imageCandidates = options.captureImages
			? extractImageCandidates(article.content ?? "", resource.url, options.maxImages)
			: undefined;

		if (options.view === "tree") {
			return {
				page: {
					...identity,
					view: "tree",
					wordCount,
					readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
					chunks: chunk(markdown, resource.url),
					markdown,
					tree: buildTree(article.content ?? "", resource.url),
				},
				...(imageCandidates ? { imageCandidates } : {}),
			};
		}

		let chunks = chunk(markdown, resource.url);
		if (options.tokenBudget !== undefined) {
			let remaining = options.tokenBudget * 4;
			let first = true;
			chunks = chunks.filter((part) => {
				if (!first && remaining <= 0) return false;
				first = false;
				remaining -= part.text.length;
				return true;
			});
		}
		const finalMarkdown = options.tokenBudget !== undefined ? chunks.map((part) => part.text).join("\n\n") : markdown;
		return {
			page: {
				...identity,
				wordCount,
				readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
				chunks,
				markdown: finalMarkdown,
				...(jsRendered ? { jsRendered: true } : {}),
			},
			...(imageCandidates ? { imageCandidates } : {}),
		};
	},
};

const BUILT_IN_EXTRACTORS: readonly ContentExtractor[] = [new PdfContentExtractor(), htmlExtractor, textualExtractor];

/** Select the first caller-provided Strategy that supports the resource, then fall back to built-ins. */
export async function extractFetchedResource(
	resource: FetchedResource,
	options: ContentExtractionOptions,
	customExtractors: readonly ContentExtractor[] = [],
): Promise<ContentExtractionResult> {
	const extractor = [...customExtractors, ...BUILT_IN_EXTRACTORS].find((candidate) => candidate.supports(resource));
	if (!extractor) {
		throw new Error(
			`Cannot extract content from "${resource.url}" — server returned "${resource.contentType ?? "an unknown content type"}", which web-spider cannot parse as text or structure`,
		);
	}
	return extractor.extract(resource, options);
}
