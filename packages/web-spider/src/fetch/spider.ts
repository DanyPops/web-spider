import { isLikelyFetchTransportFailure, ResponseTooLargeError, toFetchTransportError } from "../errors.js";
import type { IHttpClient, IRobotsChecker, ISsrfGuard, IThrottle } from "../ports.js";
import type { ContentSourceStrategy } from "../sources/content-source.js";
import { queryGitHub } from "../sources/github.js";
import { probeLlmsTxt } from "../sources/llms-txt.js";
import { probeMarkdownVariant } from "../sources/markdown-suffix.js";
import { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "../sources/mediawiki.js";
import type { ImageRef, LeanPage, SpideredPage } from "../types.js";
import {
	type ContentExtractionOptions,
	type ContentExtractor,
	type ExtractedImageCandidate,
	extractFetchedResource,
	type FetchedResource,
	type TreePage,
} from "./content-extractor.js";
import { DefaultSsrfGuard } from "./ssrf-guard.js";

export type { TreePage } from "./content-extractor.js";

// ---------------------------------------------------------------------------
// Default HTTP client adapter
// ---------------------------------------------------------------------------

/** Default outbound response bound -- generous enough for real docs/PDFs, small enough to cap worst-case memory per fetch. */
export const DEFAULT_MAX_RESPONSE_BYTES = 25_000_000;

/** Reads res.body via its stream reader, throwing once the running total exceeds maxBytes -- catches a chunked/compressed body a Content-Length check alone would miss. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw new ResponseTooLargeError(maxBytes);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** The real, network-touching IHttpClient -- every default fetch path shares one instance, so the ISsrfGuard/size-bound checks live here once instead of at each call site. */
export function createDefaultHttpClient(
	guard: ISsrfGuard = new DefaultSsrfGuard(),
	maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): IHttpClient {
	return {
		async fetch(req) {
			await guard.assertAllowed(req.url);
			const res = await globalThis.fetch(req.url, {
				signal: req.signal,
				headers: req.headers,
			});
			// Single-use, like the real Response body -- whichever accessor is called first wins.
			let bodyRead: Promise<Uint8Array> | undefined;
			const readOnce = () => (bodyRead ??= readBoundedBody(res, maxResponseBytes));
			return {
				ok: res.ok,
				status: res.status,
				statusText: res.statusText,
				headers: { get: (name: string) => res.headers.get(name) },
				text: async () => new TextDecoder().decode(await readOnce()),
				arrayBuffer: async () => {
					const bytes = await readOnce();
					return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				},
			};
		},
	};
}

const sharedDefaultHttpClient = createDefaultHttpClient();

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
	/** First PDF page to extract (1-based, inclusive). Defaults to 1. */
	pdfPageStart?: number;
	/** Last PDF page to extract (1-based, inclusive). At most 50 pages per request. */
	pdfPageEnd?: number;
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
	 * HTTP client — defaults to a global fetch() adapter guarded by ssrfGuard.
	 * Inject a stub for testing without real network access.
	 */
	httpClient?: IHttpClient;
	/**
	 * SSRF guard for the default HTTP client -- default-deny on loopback/
	 * private/link-local/reserved targets. No effect on a caller-supplied
	 * httpClient. Override to widen the blocklist or disable it.
	 */
	ssrfGuard?: ISsrfGuard;
	/**
	 * Byte bound on the default HTTP client's response body, enforced while
	 * streaming (not just via Content-Length). Default: DEFAULT_MAX_RESPONSE_BYTES.
	 * No effect on a caller-supplied httpClient.
	 */
	maxResponseBytes?: number;
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
	/**
	 * When true and the URL is a github.com repo/issue/pull-request page,
	 * queries GitHub's real REST API for structured data (repo metadata +
	 * README, or issue/PR title/state/labels/body) instead of scraping
	 * GitHub's JS-heavy rendered pages. Unauthenticated requests are limited
	 * to 60/hour per IP (GitHub's own limit, verified directly) -- pass
	 * githubToken, or set GITHUB_TOKEN/GH_TOKEN in the environment, to raise
	 * this to 5,000/hour. `url` is unchanged (same resource, different
	 * mechanism). Falls through unchanged for blob/wiki/other URL shapes,
	 * non-github.com hosts, or any API failure (rate limit, 404, network).
	 * Default: false — preserves the existing fetch contract exactly.
	 */
	preferGitHub?: boolean;
	/** Explicit GitHub token for preferGitHub; falls back to GITHUB_TOKEN/GH_TOKEN env vars. Never logged. */
	githubToken?: string;
	/**
	 * Pure response-content Strategies tried before Web Spider's built-in HTML
	 * and textual extractors. First supporting extractor wins.
	 */
	contentExtractors?: readonly ContentExtractor[];
	/**
	 * Per-site/per-convention ContentSourceStrategies (see
	 * ../sources/content-source.ts, docs/content-source-strategies.md), tried
	 * in order before the legacy preferLlmsTxt/preferMarkdownVariant/
	 * preferGitHub/preferMediaWiki flags below. The first strategy whose
	 * `matches(url)` returns true AND whose `fetch()` returns a non-null
	 * result wins; a miss falls through to the next strategy, then to the
	 * legacy flags, then to a plain fetch — exactly like `contentExtractors`.
	 * This is the extension point for adding a new site (Wikipedia, GitHub,
	 * YouTube, or your own) without editing spider() itself: implement
	 * ContentSourceStrategy and pass an instance here, or register it by name
	 * via ../sources/registry.ts and resolve it with resolveContentSources().
	 * Default: [] — preserves the existing fetch contract exactly.
	 */
	contentSources?: readonly ContentSourceStrategy[];
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

/** Hydrate pure image candidates after extraction. Failed image fetches are silently skipped. */
async function fetchImages(
	candidates: readonly ExtractedImageCandidate[],
	httpClient: IHttpClient,
	throttle?: IThrottle,
): Promise<ImageRef[]> {
	const results: ImageRef[] = [];
	for (const { src, alt } of candidates) {
		if (src.startsWith("data:")) {
			const match = /^data:([^;]+);base64,(.+)$/.exec(src);
			if (match) results.push({ src, mimeType: match[1], alt, base64: match[2] });
			continue;
		}

		try {
			if (throttle) await throttle.wait(src);
			const res = await httpClient.fetch({
				url: src,
				headers: { "User-Agent": "web-spider/0.1", Accept: "image/*" },
			});
			if (!res.ok) continue;
			throttle?.success(src);

			const buf = await res.arrayBuffer();
			const base64 = Buffer.from(buf).toString("base64");
			const contentType = res.headers.get("content-type");
			const mimeType = contentType?.split(";")[0].trim() || mimeFromUrl(src);
			results.push({ src, mimeType, alt, base64 });
		} catch {
			// A missing image must never fail the page scrape.
		}
	}
	return results;
}

/** Minimal HTML-text escape for wrapping a MediaWiki API title in a synthetic <title> tag. */
function escapeHtmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
		pdfPageStart,
		pdfPageEnd,
		throttle,
		robotsCache,
		httpClient,
		ssrfGuard,
		maxResponseBytes,
		captureImages = false,
		maxImages = 10,
		preferLlmsTxt = false,
		preferMarkdownVariant = false,
		preferMediaWiki = false,
		preferGitHub = false,
		githubToken,
		contentExtractors = [],
		contentSources = [],
	} = opts ?? {};

	// ssrfGuard/maxResponseBytes only configure the default client -- a caller-supplied httpClient is used as given.
	const client =
		httpClient ??
		(ssrfGuard !== undefined || maxResponseBytes !== undefined
			? createDefaultHttpClient(ssrfGuard, maxResponseBytes)
			: sharedDefaultHttpClient);

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

	const extractionOptions: ContentExtractionOptions = {
		view,
		rootSelector,
		excludeSelectors,
		tokenBudget,
		pdfPageStart,
		pdfPageEnd,
		captureImages,
		maxImages,
	};
	const extract = async (resource: FetchedResource) => extractFetchedResource(resource, extractionOptions, contentExtractors);

	// Check robots.txt before fetching.
	if (robotsCache) {
		const { allowed, crawlDelayMs } = await robotsCache.check(url);
		if (!allowed) throw new Error(`Blocked by robots.txt: ${url}`);
		if (crawlDelayMs && throttle) {
			throttle.setDomainDelay(parsedUrl.hostname, crawlDelayMs);
		}
	}

	// Caller-supplied ContentSourceStrategies: tried first, in order, ahead of
	// the legacy preferX flags below — the general extension point new site
	// adapters plug into without editing spider() itself. Only attempted after
	// the robots.txt check above already passed for this host.
	for (const source of contentSources) {
		if (!source.matches(url)) continue;
		const result = await source.fetch({ url, httpClient: client, timeoutMs, userAgent });
		if (!result) continue;
		const resultDomain = new URL(result.url).hostname.replace(/^www\./, "");
		const { page } = await extract({
			url: result.url,
			domain: resultDomain,
			fetchedAt: new Date().toISOString(),
			contentType: result.contentType,
			text: result.text,
		});
		return { ...page, ...(result.title ? { title: result.title } : {}), viaStrategy: source.name };
	}

	// llms.txt strategy: cheap probe before the normal fetch+Readability path.
	// Only attempted after the robots.txt check above already passed for this
	// host, so a site-wide Disallow still blocks this too. A miss falls
	// through to the normal path unchanged, as if preferLlmsTxt were never set.
	if (preferLlmsTxt) {
		const probe = await probeLlmsTxt(url, client, { timeoutMs, userAgent });
		if (probe) {
			const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
			const { page } = await extract({
				url: probe.url,
				domain: probeDomain,
				fetchedAt: new Date().toISOString(),
				contentType: probe.contentType,
				text: probe.content,
			});
			return { ...page, viaStrategy: "llms.txt" };
		}
	}

	// .md URL-suffix strategy: same page, cleaner variant. Checked after
	// preferLlmsTxt above (a broader site-wide index) misses or is disabled.
	if (preferMarkdownVariant) {
		const probe = await probeMarkdownVariant(url, client, { timeoutMs, userAgent });
		if (probe) {
			const probeDomain = new URL(probe.url).hostname.replace(/^www\./, "");
			const { page } = await extract({
				url: probe.url,
				domain: probeDomain,
				fetchedAt: new Date().toISOString(),
				contentType: probe.contentType,
				text: probe.content,
			});
			return { ...page, viaStrategy: "markdown-suffix" };
		}
	}

	// GitHub API strategy: repo/issue/PR metadata via the real REST API
	// instead of scraping GitHub's JS-heavy rendered pages. Same resource,
	// different mechanism, so url stays the originally requested one.
	if (preferGitHub) {
		const result = await queryGitHub(url, client, { token: githubToken, timeoutMs, userAgent });
		if (result) {
			const { page } = await extract({
				url,
				domain: new URL(url).hostname.replace(/^www\./, ""),
				fetchedAt: new Date().toISOString(),
				contentType: "text/markdown; charset=utf-8",
				text: result.markdown,
			});
			return { ...page, title: result.title, viaStrategy: "github" };
		}
	}

	let responseText = "";
	let responseBytes: Uint8Array | undefined;
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
			const siteInfo = await detectMediaWiki(url, client, { timeoutMs, userAgent });
			if (siteInfo) {
				const page = await queryMediaWikiPage(siteInfo.apiUrl, pageTitle, client, { timeoutMs, userAgent });
				if (page) {
					responseText = `<html><head><title>${escapeHtmlText(page.title)}</title></head><body>${page.html}</body></html>`;
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
			res = await client.fetch({
				url,
				signal: controller.signal,
				headers: { "User-Agent": userAgent, Accept: "text/html, application/pdf;q=0.9" },
			});
		} catch (err) {
			clearTimeout(timer);
			if (controller.signal.aborted || isLikelyFetchTransportFailure(err)) {
				throw toFetchTransportError(err, { timedOut: controller.signal.aborted });
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
		throttle?.success(url);
		responseBytes = new Uint8Array(await res.arrayBuffer());
		responseText = new TextDecoder().decode(responseBytes);
		if (responseBytes.byteLength === 0) {
			// Preserve compatibility with structural IHttpClient fakes/adapters that
			// historically supplied text() but used an empty arrayBuffer placeholder.
			// A real consumed empty Response rejects text(); empty remains correct.
			try {
				responseText = await res.text();
				responseBytes = new TextEncoder().encode(responseText);
			} catch {
				// The real response body was empty and has already been consumed.
			}
		}
		fetchError = null;
		break;
	}

	if (fetchError) throw fetchError;

	const resource: FetchedResource = {
		url,
		domain: new URL(url).hostname.replace(/^www\./, ""),
		fetchedAt: new Date().toISOString(),
		contentType: contentTypeHeader,
		text: responseText,
		...(responseBytes ? { bytes: responseBytes } : {}),
	};
	const { page, imageCandidates } = await extract(resource);
	const images = imageCandidates ? await fetchImages(imageCandidates, client, throttle) : undefined;
	return {
		...page,
		...(images ? { images } : {}),
		...(viaMediaWiki ? { viaStrategy: "mediawiki" } : {}),
	} as SpideredPage | LeanPage | TreePage;
}
