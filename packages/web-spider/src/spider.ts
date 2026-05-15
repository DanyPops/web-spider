import { Readability } from "@mozilla/readability";
import { chunk, toMarkdown } from "./convert.js";
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
		return globalThis.fetch(req.url, {
			signal: req.signal,
			headers: req.headers,
		});
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
/** A page with its full DOM tree attached. */
export interface TreePage extends SpideredPage {
	readonly view: "tree";
	tree: DOMNode;
}

export async function spider(url: string, opts: SpiderOptions & { view: "lean" }): Promise<LeanPage>;
export async function spider(url: string, opts: SpiderOptions & { view: "tree" }): Promise<TreePage>;
export async function spider(url: string, opts?: SpiderOptions & { view?: "full" }): Promise<SpideredPage>;
export async function spider(
	url: string,
	opts?: SpiderOptions & { view?: "lean" | "full" | "tree" },
): Promise<SpideredPage | LeanPage | TreePage> {
	const {
		timeoutMs = 10_000,
		userAgent = "web-spider/0.1 (AI agent research tool; +https://github.com/dpopsuev)",
		view = "full",
		rootSelector,
		excludeSelectors,
		tokenBudget,
		throttle,
		robotsCache,
		httpClient = defaultHttpClient,
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

	// Fetch with optional throttle + retry on 429/503.
	const maxRetries = throttle?.maxRetries ?? 0;
	let html = "";
	let fetchError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

		throttle?.success(url);
		html = await res.text();
		fetchError = null;
		break;
	}

	if (fetchError) throw fetchError;

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

	const domain = new URL(url).hostname.replace(/^www\./, "");
	const fetchedAt = new Date().toISOString();

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
		return { ...lean, chunkCount, ...(jsRendered ? { jsRendered: true } : {}) };
	}

	// ---------------------------------------------------------------------------
	// Tree path — build semantic DOM tree, then also produce full markdown
	// ---------------------------------------------------------------------------
	if (view === "tree") {
		const tree = buildTree(article.content ?? "", url);
		const markdown = toMarkdown(article.content ?? "");
		const wordCount = markdown.split(/\s+/).filter(Boolean).length;
		const chunks = chunk(markdown, url);
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
		};
	}

	// ---------------------------------------------------------------------------
	// Full path — turndown + chunk
	// ---------------------------------------------------------------------------
	const markdown = toMarkdown(article.content ?? "");
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
		...(jsRendered ? { jsRendered: true } : {}),
	};
}
