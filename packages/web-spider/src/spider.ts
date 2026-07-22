import { Readability } from "@mozilla/readability";
import { classifyContentType } from "./content-type.js";
import { chunk, toMarkdown } from "./convert.js";
import { probeLlmsTxt } from "./llms-txt.js";
import { probeMarkdownVariant } from "./markdown-suffix.js";
import { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "./mediawiki.js";
import type { ImageRef } from "./types.js";
import { extractCanonicalUrl, extractHeadings, extractLinks, extractTags, parseDom } from "./parse.js";
import type { IHttpClient, IRobotsChecker, IThrottle } from "./ports.js";
import { buildTree } from "./tree.js";
import type { DOMNode, LeanPage, SpideredPage } from "./types.js";
import { toLean } from "./views.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORDS_PER_MINUTE = 200;

// ---------------------------------------------------------------------------
// Default HTTP client adapter
// ---------------------------------------------------------------------------

const defaultHttpClient: IHttpClient = {
	async fetch(req) {
		const res = await globalThis.fetch(req.url, {
			signal: req.signal,
			headers: req.headers,
		});
		return {
			ok: res.ok,
			status: res.status,
			statusText: res.statusText,
			headers: { get: (name: string) => res.headers.get(name) },
			text: () => res.text(),
			arrayBuffer: () => res.arrayBuffer(),
		};
	},
};



// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpiderOptions {
	/**
	 * ms before aborting the fetch (default 10 000).
	 */
	timeoutMs?: number;
	/**
	 * Value sent as User-Agent.
	 * Default identifies the tool; override for sites that block generic crawlers.
	 */
	userAgent?: string;
	/**
	 * CSS selector that scopes content extraction to a specific element.
	 * Everything outside the matched element is discarded before Readability runs.
	 * Example: "article", ".main-content", "#post-body"
	 */
	rootSelector?: string;
	/**
	 * Comma-separated CSS selectors whose matched elements are removed before
	 * extraction. Applied before Readability, so excluded content never reaches
	 * the chunks or markdown.
	 * Example: "nav, footer, .sidebar, #ads"
	 */
	excludeSelectors?: string;
	/**
	 * Approximate maximum token budget for the returned content.
	 * Markdown is truncated to fit. Rough estimate: 1 token ≈ 4 characters.
	 * Does not affect lean view (headings/links are always small).
	 * Default: unlimited.
	 */
	tokenBudget?: number;
	/**
	 * Per-domain throttle — shared across spider() calls to enforce rate limits
	 * and exponential backoff on 429/503 responses.
	 */
	throttle?: IThrottle;
	/**
	 * robots.txt checker — when provided, spider() checks robots.txt before
	 * fetching and respects Crawl-delay directives.
	 */
	robotsCache?: IRobotsChecker;
	/**
	 * HTTP client — defaults to a global fetch() adapter.
	 * Inject a stub for testing without real network access.
	 */
	httpClient?: IHttpClient;
	/**
	 * When true, fetch <img> src URLs found in the article content and attach
	 * them as base64-encoded ImageRef objects to SpideredPage.images.
	 * Default: false — preserves current behaviour exactly.
	 */
	captureImages?: boolean;
	/**
	 * Maximum number of images to fetch per page.
	 * Default: 10.
	 */
	maxImages?: number;
	/**
	 * When true, probes the target URL's origin for a real llms.txt before
	 * the normal fetch+Readability path. If found, returns a page built
	 * directly from the llms.txt content (viaStrategy: "llms.txt", url set
	 * to the llms.txt URL actually fetched) instead of parsing the requested
	 * URL's own HTML. If not found, falls through to the normal path
	 * unchanged as if this option were never set.
	 * Default: false — preserves the existing fetch contract exactly.
	 */
	preferLlmsTxt?: boolean;
	/**
	 * When true, probes for a .md sibling of the exact requested URL (e.g.
	 * Welcome.html -> Welcome.md) before the normal fetch+Readability path.
	 * Verified real against docs.aws.amazon.com; a spreading convention on
	 * other documentation platforms too. Checked after preferLlmsTxt (a
	 * site-wide index) misses or is disabled. Falls through unchanged when
	 * no .md sibling exists.
	 * Default: false — preserves the existing fetch contract exactly.
	 */
	preferMarkdownVariant?: boolean;
	/**
	 * When true and the URL looks like a MediaWiki article (Wikipedia,
	 * Wiktionary, Fandom wikis, ArchWiki, Gentoo Wiki, or any self-hosted
	 * instance), queries the wiki's real API (action=parse) for the
	 * article's own content HTML instead of scraping the rendered page
	 * (nav/sidebar/search-box chrome). Unlike preferLlmsTxt/
	 * preferMarkdownVariant, this does not change `url` — it's the same
	 * resource via a different retrieval mechanism, so the result still
	 * goes through the normal Readability/metadata pipeline on the API's
	 * (already much cleaner) HTML. Falls through unchanged when the URL
	 * doesn't look like an article, or the site isn't MediaWiki-based.
	 * Default: false — preserves the existing fetch contract exactly.
	 */
	preferMediaWiki?: boolean;
}

/**
 * Spider a single URL and return a fully structured SpideredPage.
 *
 * Pass `view: "lean"` to skip chunking and markdown conversion — returns a
 * LeanPage with only identity, metadata, and the heading/link outline.
 * Significantly faster (~3×) and uses far fewer tokens in agent context.
 *
 * Errors are returned as thrown exceptions with a descriptive message rather
 * than crashing silently. Common cases:
 * - Non-HTTP URLs throw immediately with a clear message.
 * - HTTP errors include the status code.
 * - JS-rendered pages (wordCount === 0) include a hint.
 * - Timeouts include the configured limit.
 *
 * @example
 * // Full page — chunks, markdown, all metadata
 * const page = await spider("https://example.com")
 *
 * @example
 * // Lean overview — no body text, ideal for navigation decisions
 * const lean = await spider("https://example.com", { view: "lean" })
 */
// ---------------------------------------------------------------------------
// Image fetching
// ---------------------------------------------------------------------------

/** Detect MIME type from a URL path extension, defaulting to image/jpeg. */
function mimeFromUrl(src: string): string {
	const ext = src.split("?")[0].split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
		gif: "image/gif",
		svg: "image/svg+xml",
		avif: "image/avif",
	};
	return map[ext ?? ""] ?? "image/jpeg";
}

/**
 * Extract <img> elements from article HTML, resolve src URLs, and fetch
 * each as a base64-encoded ImageRef. data: URLs are included without fetching.
 * Failed fetches are silently skipped.
 */
async function fetchImages(
	articleHtml: string,
	pageUrl: string,
	httpClient: IHttpClient,
	maxImages: number,
	throttle?: IThrottle,
): Promise<ImageRef[]> {
	// Parse the article HTML to extract img elements.
	const { parseDom } = await import("./parse.js");
	const doc = parseDom(articleHtml, pageUrl);
	const imgEls = [...doc.querySelectorAll("img")].slice(0, maxImages);

	const results: ImageRef[] = [];

	for (const el of imgEls) {
		const rawSrc = el.getAttribute("src") ?? "";
		if (!rawSrc) continue;

		const alt = el.getAttribute("alt") ?? "";

		// data: URLs — include without fetching.
		if (rawSrc.startsWith("data:")) {
			const match = /^data:([^;]+);base64,(.+)$/.exec(rawSrc);
			if (match) {
				results.push({ src: rawSrc, mimeType: match[1], alt, base64: match[2] });
			}
			continue;
		}

		// Resolve relative URLs.
		let absoluteSrc: string;
		try {
			absoluteSrc = new URL(rawSrc, pageUrl).toString();
		} catch {
			continue;
		}

		try {
			if (throttle) await throttle.wait(absoluteSrc);
			const res = await httpClient.fetch({
				url: absoluteSrc,
				headers: { "User-Agent": "web-spider/0.1", Accept: "image/*" },
			});
			if (!res.ok) continue;
			throttle?.success(absoluteSrc);

			const buf = await res.arrayBuffer();
			const base64 = Buffer.from(buf).toString("base64");
			const contentType = res.headers.get("content-type");
			const mimeType = contentType?.split(";")[0].trim() || mimeFromUrl(absoluteSrc);

			results.push({ src: absoluteSrc, mimeType, alt, base64 });
		} catch {
			// Skip failed image fetches silently — a missing image should never
			// cause the whole page scrape to fail.
		}
	}

	return results;
}

/** A page with its full DOM tree attached. */
export interface TreePage extends SpideredPage {
	readonly view: "tree";
	tree: DOMNode;
}

// ---------------------------------------------------------------------------
// Non-HTML content (text/plain, JSON, XML/RSS/Atom, ...)
// ---------------------------------------------------------------------------

/** Pretty-prints parseable JSON for readability; returns the raw text unchanged for anything else (invalid JSON, JSONL, ...) rather than guessing. */
function prettyPrintIfJson(rawText: string): string {
	try {
		return JSON.stringify(JSON.parse(rawText), null, 2);
	} catch {
		return rawText;
	}
}

/** A human-meaningful fallback title when there is no <title> tag to read — the URL's last path segment, or the hostname for a bare root URL. */
/** Minimal HTML-text escape for wrapping a MediaWiki API title in a synthetic <title> tag. */
function escapeHtmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function titleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
	} catch {
		return url;
	}
}

/**
 * Extracts a heading outline from plain text using the same "#"/"##"/"###"
 * convention chunk() already looks for — real signal for text/markdown
 * content (READMEs, llms.txt-style docs), harmless (empty) for anything
 * else that happens not to use it.
 */
function extractMarkdownHeadings(text: string): SpideredPage["headings"] {
	const headings: SpideredPage["headings"] = [];
	for (const line of text.split("\n")) {
		const match = /^(#{1,3})\s+(.+)/.exec(line.trim());
		if (match) headings.push({ level: match[1].length as 1 | 2 | 3, text: match[2].trim() });
	}
	return headings;
}

/**
 * Builds a SpideredPage/LeanPage/TreePage directly from a non-HTML response
 * body — no linkedom, no Readability; there is no DOM to parse. JSON is
 * pretty-printed when it parses; everything else (plain text, XML/RSS/Atom,
 * unparseable JSON) is returned as the server sent it. `contentType` is
 * always set here (never on an HTML result) so callers can tell what
 * actually happened rather than silently getting an empty-looking page.
 */
function buildNonHtmlPage(params: {
	url: string;
	domain: string;
	fetchedAt: string;
	contentTypeHeader: string | null;
	rawText: string;
	view: "lean" | "full" | "tree";
	isJson: boolean;
}): SpideredPage | LeanPage | TreePage {
	const { url, domain, fetchedAt, contentTypeHeader, rawText, view, isJson } = params;
	const text = isJson ? prettyPrintIfJson(rawText) : rawText;
	const wordCount = text.split(/\s+/).filter(Boolean).length;
	const headings = extractMarkdownHeadings(text);
	const title = titleFromUrl(url);
	const readingTimeMinutes = Math.ceil(wordCount / WORDS_PER_MINUTE);
	const contentTypeField = contentTypeHeader ? { contentType: contentTypeHeader } : {};

	if (view === "lean") {
		return {
			view: "lean",
			url, domain, fetchedAt, title,
			lang: "",
			tags: [],
			wordCount, readingTimeMinutes,
			chunkCount: Math.max(0, Math.floor(wordCount / 150)),
			headings: headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
			links: [],
			...contentTypeField,
		};
	}

	const chunks = chunk(text, url);
	const base = {
		url, domain, fetchedAt, title,
		description: "", author: "", publishedAt: "", lang: "",
		tags: [],
		wordCount, readingTimeMinutes,
		headings, chunks, links: [],
		markdown: text,
		...contentTypeField,
	};

	if (view === "tree") {
		return { ...base, view: "tree", tree: { tag: "text", path: "text", text } };
	}

	return base;
}

export async function spider(url: string, opts: SpiderOptions & { view: "lean" }): Promise<LeanPage>;
export async function spider(url: string, opts: SpiderOptions & { view: "tree" }): Promise<TreePage>;
export async function spider(url: string, opts?: SpiderOptions & { view?: "full" }): Promise<SpideredPage>;
export async function spider(
	url: string,
	opts?: SpiderOptions & { view?: "lean" | "full" | "tree" },
): Promise<SpideredPage | LeanPage | TreePage> {
	const {
		timeoutMs = 30_000,
		userAgent = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)",
		view = "full",
		rootSelector,
		excludeSelectors,
		tokenBudget,
		throttle,
		robotsCache,
		httpClient = defaultHttpClient,
		captureImages = false,
		maxImages = 10,
		preferLlmsTxt = false,
		preferMarkdownVariant = false,
		preferMediaWiki = false,
	} = opts ?? {};

	// Poka-yoke: reject non-HTTP URLs immediately with a clear message.
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error(`Invalid URL: "${url}" — must be a fully-qualified http/https URL`);
	}
	if (!["http:", "https:"].includes(parsedUrl.protocol)) {
		throw new Error(`Unsupported protocol "${parsedUrl.protocol}" — only http and https are supported`);
	}

	// Check robots.txt before fetching.
	if (robotsCache) {
		const { allowed, crawlDelayMs } = await robotsCache.check(url);
		if (!allowed) throw new Error(`Blocked by robots.txt: ${url}`);
		if (crawlDelayMs && throttle) {
			throttle.setDomainDelay(parsedUrl.hostname, crawlDelayMs);
		}
	}

	// llms.txt strategy: cheap probe before the normal fetch+Readability path.
	// Only attempted after the robots.txt check above already passed for this
	// host, so a site-wide Disallow still blocks this too. A miss falls
	// through to the normal path unchanged, as if preferLlmsTxt were never set.
	if (preferLlmsTxt) {
		const probe = await probeLlmsTxt(url, httpClient, { timeoutMs, userAgent });
		if (probe) {
			const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
			const page = buildNonHtmlPage({
				url: probe.url,
				domain: probeDomain,
				fetchedAt: new Date().toISOString(),
				contentTypeHeader: probe.contentType,
				rawText: probe.content,
				view,
				isJson: false,
			});
			return { ...page, viaStrategy: "llms.txt" };
		}
	}

	// .md URL-suffix strategy: same page, cleaner variant. Checked after
	// preferLlmsTxt above (a broader site-wide index) misses or is disabled.
	if (preferMarkdownVariant) {
		const probe = await probeMarkdownVariant(url, httpClient, { timeoutMs, userAgent });
		if (probe) {
			const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
			const page = buildNonHtmlPage({
				url: probe.url,
				domain: probeDomain,
				fetchedAt: new Date().toISOString(),
				contentTypeHeader: probe.contentType,
				rawText: probe.content,
				view,
				isJson: false,
			});
			return { ...page, viaStrategy: "markdown-suffix" };
		}
	}

	let html = "";
	let fetchError: Error | null = null;
	let contentTypeHeader: string | null = null;
	let viaMediaWiki = false;

	// MediaWiki strategy: query the platform's real API for the article's own
	// content HTML instead of scraping the rendered wiki page. Sets html/
	// contentTypeHeader directly and skips the fetch loop below entirely on a
	// hit; a miss (not an article URL, or not a MediaWiki site) falls through
	// to the normal fetch unchanged.
	if (preferMediaWiki) {
		const pageTitle = extractWikiPageTitle(url);
		if (pageTitle) {
			const siteInfo = await detectMediaWiki(url, httpClient, { timeoutMs, userAgent });
			if (siteInfo) {
				const page = await queryMediaWikiPage(siteInfo.apiUrl, pageTitle, httpClient, { timeoutMs, userAgent });
				if (page) {
					html = `<html><head><title>${escapeHtmlText(page.title)}</title></head><body>${page.html}</body></html>`;
					contentTypeHeader = "text/html; charset=utf-8";
					viaMediaWiki = true;
				}
			}
		}
	}

	// Fetch with optional throttle + retry on 429/503 — skipped entirely when
	// the MediaWiki strategy above already produced content.
	const maxRetries = throttle?.maxRetries ?? 0;

	for (let attempt = 0; !viaMediaWiki && attempt <= maxRetries; attempt++) {
		if (throttle) await throttle.wait(url);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let res: Awaited<ReturnType<IHttpClient["fetch"]>>;
		try {
			res = await httpClient.fetch({
				url,
				signal: controller.signal,
				headers: { "User-Agent": userAgent, Accept: "text/html" },
			});
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`Timeout after ${timeoutMs}ms — ${url}`);
			}
			throw err;
		}
		clearTimeout(timer);

		if (res.status === 429 || res.status === 503) {
			if (throttle && attempt < maxRetries) {
				throttle.rateLimit(url, res.headers.get("Retry-After"));
				fetchError = new Error(`HTTP ${res.status} — retrying (attempt ${attempt + 1}/${maxRetries})`);
				continue;
			}
			throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
		}

		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);

		contentTypeHeader = res.headers.get("content-type");
		const kind = classifyContentType(contentTypeHeader);
		if (kind === "unsupported") {
			throw new Error(
				`Cannot extract content from "${url}" — server returned "${contentTypeHeader ?? "an unknown content type"}", which web-spider cannot parse as text or structure`,
			);
		}

		throttle?.success(url);
		html = await res.text();
		fetchError = null;
		break;
	}

	if (fetchError) throw fetchError;

	const domain = new URL(url).hostname.replace(/^www\./, "");
	const fetchedAt = new Date().toISOString();
	const contentKind = classifyContentType(contentTypeHeader);

	// Non-HTML content (text/plain, JSON, XML/RSS/Atom, ...) never reaches
	// linkedom/Readability at all — there is no DOM to parse. Return the raw
	// (or, for JSON, pretty-printed) body directly instead.
	if (contentKind !== "html") {
		return buildNonHtmlPage({ url, domain, fetchedAt, contentTypeHeader, rawText: html, view, isJson: contentKind === "json" });
	}

	// Parse DOM via parse.ts — keeps the JSDOM dependency in one module.
	const doc = parseDom(html, url);

	// Apply excludeSelectors before Readability strips the DOM.
	if (excludeSelectors) {
		for (const sel of excludeSelectors
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			for (const el of [...doc.querySelectorAll(sel)]) el.remove();
		}
	}

	// Scope to rootSelector: replace body content with the matched element.
	if (rootSelector) {
		const root = doc.querySelector(rootSelector);
		if (root) {
			doc.body.innerHTML = root.outerHTML;
		}
	}

	const links = extractLinks(doc, url);
	const canonicalUrl = extractCanonicalUrl(doc, url);

	// Readability content extraction (Firefox Reader View engine).
	const readabilityResult = new Readability(doc).parse();
	const jsRendered = !readabilityResult;
	// Graceful degradation: if Readability finds nothing, return a partial page
	// with jsRendered:true rather than throwing. The agent can decide what to do.
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
		const el =
			doc.querySelector(`meta[name="${name}"]`) ??
			doc.querySelector(`meta[property="og:${name}"]`) ??
			doc.querySelector(`meta[property="${name}"]`);
		return (el?.getAttribute("content") ?? "").trim();
	};

	// headings must come before tags so the heading fallback is available.
	const headings = extractHeadings(article.content ?? "");
	const tags = extractTags(doc);

	// ---------------------------------------------------------------------------
	// Lean fast-path — skip turndown + chunking entirely
	// ---------------------------------------------------------------------------
	if (view === "lean") {
		const textContent = (article.textContent ?? "").trim();
		const wordCount = textContent.split(/\s+/).filter(Boolean).length;
		const chunkCount = Math.max(0, Math.floor(wordCount / 150));

		const full = {
			url,
			domain,
			fetchedAt,
			...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
			title: article.title ?? meta("title"),
			description: meta("description"),
			author: article.byline ?? meta("author"),
			publishedAt: meta("article:published_time") ?? meta("date"),
			lang: doc.documentElement.lang ?? "en",
			tags,
			wordCount,
			readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
			chunks: [], // placeholder — toLean reads chunks.length
			headings,
			links,
			markdown: "",
		} satisfies SpideredPage;
		const lean = toLean(full);
		return { ...lean, chunkCount, ...(jsRendered ? { jsRendered: true } : {}), ...(viaMediaWiki ? { viaStrategy: "mediawiki" } : {}) };
	}

	// ---------------------------------------------------------------------------
	// Tree path — build semantic DOM tree, then also produce full markdown
	// ---------------------------------------------------------------------------
	if (view === "tree") {
		const tree = buildTree(article.content ?? "", url);
		const markdown = toMarkdown(article.content ?? "", { keepImages: captureImages });
		const wordCount = markdown.split(/\s+/).filter(Boolean).length;
		const chunks = chunk(markdown, url);
		const images = captureImages
			? await fetchImages(article.content ?? "", url, httpClient, maxImages, throttle)
			: undefined;
		return {
			view: "tree",
			url,
			domain,
			fetchedAt,
			...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
			title: article.title ?? meta("title"),
			description: meta("description"),
			author: article.byline ?? meta("author"),
			publishedAt: meta("article:published_time") ?? meta("date"),
			lang: doc.documentElement.lang ?? "en",
			tags,
			wordCount,
			readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
			headings,
			chunks,
			links,
			markdown,
			tree,
			...(images ? { images } : {}),
			...(viaMediaWiki ? { viaStrategy: "mediawiki" } : {}),
		};
	}

	// ---------------------------------------------------------------------------
	// Full path — turndown + chunk
	// ---------------------------------------------------------------------------
	const markdown = toMarkdown(article.content ?? "", { keepImages: captureImages });
	const wordCount = markdown.split(/\s+/).filter(Boolean).length;

	// Chunk-aware tokenBudget: select whole chunks up to the budget rather
	// than slicing markdown mid-sentence. Preserves chunk boundaries and
	// returns the richest complete content that fits.
	let allChunks = chunk(markdown, url);
	if (tokenBudget !== undefined) {
		const charBudget = tokenBudget * 4;
		let remaining = charBudget;
		let first = true;
		allChunks = allChunks.filter((c) => {
			// Always include at least the first chunk — agents need something
			// even if it exceeds the budget.
			if (!first && remaining <= 0) return false;
			first = false;
			remaining -= c.text.length;
			return true;
		});
	}

	// Reconstruct markdown from selected chunks for full-page consumers.
	const finalMarkdown = tokenBudget !== undefined
		? allChunks.map((c) => c.text).join("\n\n")
		: markdown;

	const images = captureImages
		? await fetchImages(article.content ?? "", url, httpClient, maxImages, throttle)
		: undefined;

	return {
		url,
		domain,
		fetchedAt,
		...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
		title: article.title ?? meta("title"),
		description: meta("description"),
		author: article.byline ?? meta("author"),
		publishedAt: meta("article:published_time") ?? meta("date"),
		lang: doc.documentElement.lang ?? "en",
		tags,
		wordCount,
		readingTimeMinutes: Math.ceil(wordCount / WORDS_PER_MINUTE),
		headings,
		chunks: allChunks,
		links,
		markdown: finalMarkdown,
		...(images ? { images } : {}),
		...(jsRendered ? { jsRendered: true } : {}),
		...(viaMediaWiki ? { viaStrategy: "mediawiki" } : {}),
	};
}
