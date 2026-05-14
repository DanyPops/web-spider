import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { buildTree } from "./tree.js";
import type { RobotsCache } from "./robots.js";
import type { DomainThrottle } from "./throttle.js";
import type { Chunk, ChunkType, DOMNode, LeanPage, Link, SpideredPage } from "./types.js";
import { toLean } from "./types.js";

// ---------------------------------------------------------------------------
// Turndown setup — clean output for agents
// ---------------------------------------------------------------------------

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

// Disable character escaping. Turndown escapes markdown-special characters
// by default (\[, \*, \` etc.), producing backslash-heavy noise that is
// unnatural for agents. Since we consume the output as plain text, not as
// a markdown renderer, escaping adds no value.
(turndown as unknown as { escape: (s: string) => string }).escape = (s) => s;

// Strip images entirely — agents cannot see them, and alt-text is noise.
turndown.addRule("strip-images", {
	filter: "img",
	replacement: () => "",
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORDS_PER_MINUTE = 200;
const CHUNK_TARGET_WORDS = 150;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect the dominant content type from a markdown buffer.
 * Used to give agents a fast filter (e.g. skip code blocks when summarising).
 */
function detectContentType(lines: string[]): ChunkType {
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (t.startsWith("```")) return "code";
		if (t.startsWith("|")) return "table";
		if (/^[-*+] /.test(t) || /^\d+\. /.test(t)) return "list";
		if (t.startsWith(">")) return "blockquote";
		return "text";
	}
	return "text";
}

/**
 * Split markdown into RAG-ready chunks at heading boundaries.
 * Tables and fenced code blocks are never split — they are kept whole
 * even when they exceed CHUNK_TARGET_WORDS.
 */
function chunk(markdown: string, baseUrl: string): Chunk[] {
	const chunks: Chunk[] = [];
	const lines = markdown.split("\n");

	let heading = "";
	let buffer: string[] = [];
	let index = 0;
	let inTable = false;
	let inCode = false; // inside a ``` fence

	const flush = (): void => {
		const text = buffer.join("\n").trim();
		if (!text) return;
		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount < 10) return; // skip noise
		const contentType = detectContentType(buffer);
		chunks.push({ id: `${baseUrl}#chunk-${index}`, index, heading, text, wordCount, contentType });
		index++;
		buffer = [];
		inTable = false;
		// inCode intentionally NOT reset — a flush cannot happen mid-fence
	};

	for (const line of lines) {
		// Track fenced code block state — toggle on every ``` marker at line start.
		if (line.trim().startsWith("```")) inCode = !inCode;

		const isTableRow = line.trim().startsWith("|");

		if (inCode) {
			// Inside a fence: always buffer, never flush.
			buffer.push(line);
		} else {
			// Track whether we are inside a table block — never flush mid-table.
			if (isTableRow) {
				inTable = true;
			} else if (inTable && !isTableRow) {
				inTable = false;
			}

			const headingMatch = /^#{1,3} (.+)/.exec(line);
			if (headingMatch && !inTable) {
				const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (currentWords >= CHUNK_TARGET_WORDS) flush();
				heading = headingMatch[1];
				buffer.push(line);
			} else {
				buffer.push(line);
				const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (currentWords >= CHUNK_TARGET_WORDS && !inTable) flush();
			}
		}
	}
	flush();
	return chunks;
}

// Common class-name fragments that indicate navigation chrome.
const NAV_CLASS_RE =
	/^(nav|navbar|navigation|menu|menubar|header|footer|sidebar|breadcrumb|topbar|toolbar|site-nav|main-nav|primary-nav|global-nav)$/i;

/** True if `el` or any ancestor up to 5 levels looks like navigation chrome. */
function isNavElement(el: Element): boolean {
	// Semantic HTML5 + ARIA roles.
	if (el.closest("nav, header, footer, aside")) return true;
	if (
		el.closest(
			"[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary']",
		)
	)
		return true;

	// Class-based detection — walk up 5 ancestors.
	let node: Element | null = el;
	for (let i = 0; i < 5; i++) {
		if (!node) break;
		for (const cls of node.classList) {
			if (NAV_CLASS_RE.test(cls)) return true;
		}
		node = node.parentElement;
	}
	return false;
}

/**
 * Extract visible text from an anchor, skipping SVG subtrees.
 * SVG elements inside <a> bleed CSS/path data into textContent.
 */
function anchorText(a: Element): string {
	if (!a.querySelector("svg")) {
		return (a.textContent ?? "").replace(/\s+/g, " ").trim();
	}
	// Clone, strip SVGs, read remaining text.
	const clone = a.cloneNode(true) as Element;
	for (const svg of [...clone.querySelectorAll("svg")]) svg.remove();
	return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Extract outbound links from the DOM before Readability strips them.
 * Classifies each link as "body" (article content) or "nav" (chrome).
 */
function extractLinks(doc: Document, baseUrl: string): Link[] {
	const origin = new URL(baseUrl).origin;
	return Array.from(doc.querySelectorAll("a[href]"))
		.map((a) => {
			const href = (a as HTMLAnchorElement).href;
			const text = anchorText(a)
				.replace(
					/\b(open_in_new|navigate_next|navigate_before|arrow_drop_down|arrow_drop_up|chevron_right|chevron_left|expand_more|expand_less)\b/g,
					"",
				)
				.replace(/\s+/g, " ")
				.trim();
			if (!href || !text || href.startsWith("javascript:")) return null;

			return {
				href,
				text,
				isExternal: !href.startsWith(origin),
				rel: isNavElement(a) ? ("nav" as const) : ("body" as const),
			} satisfies Link;
		})
		.filter((l): l is Link => l !== null)
		.slice(0, 200);
}

/**
 * Extract h1/h2/h3 headings from the Readability article HTML.
 */
function extractHeadings(html: string): SpideredPage["headings"] {
	const dom = new JSDOM(html);
	const headings: SpideredPage["headings"] = [];
	dom.window.document.querySelectorAll("h1, h2, h3").forEach((el) => {
		const level = parseInt(el.tagName[1], 10) as 1 | 2 | 3;
		const text = (el.textContent ?? "").trim();
		if (text) headings.push({ level, text });
	});
	return headings;
}

/**
 * Extract topic tags from meta keywords, article:tag, og:section,
 * and — as a fallback — from the page headings.
 * Capped at 20 to avoid noise from keyword-stuffed pages.
 */
function extractTags(doc: Document, headings: Array<{ text: string }>): string[] {
	const tags = new Set<string>();

	// 1. meta keywords (comma or semicolon separated)
	const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? "";
	for (const k of keywords
		.split(/[,;]/)
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean)) {
		tags.add(k);
	}

	// 2. article:tag (can appear multiple times)
	doc.querySelectorAll('meta[property="article:tag"], meta[name="article:tag"]').forEach((el) => {
		const t = el.getAttribute("content")?.trim().toLowerCase();
		if (t) tags.add(t);
	});

	// 3. og:article:section (single taxonomy category)
	const section =
		doc.querySelector('meta[property="article:section"]')?.getAttribute("content") ??
		doc.querySelector('meta[property="og:article:section"]')?.getAttribute("content");
	if (section) tags.add(section.trim().toLowerCase());

	return [...tags].slice(0, 20);
}

/**
 * Extract the canonical URL from link[rel=canonical] or og:url.
 * Returns undefined if neither is present or if the value matches the fetched URL.
 */
function extractCanonicalUrl(doc: Document, fetchedUrl: string): string | undefined {
	const canonical =
		doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
		doc.querySelector('meta[property="og:url"]')?.getAttribute("content");

	if (!canonical) return undefined;
	// Normalise trailing slashes before comparing
	const norm = (u: string) => u.replace(/\/$/, "");
	return norm(canonical) !== norm(fetchedUrl) ? canonical : undefined;
}

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
	throttle?: DomainThrottle;
	/**
	 * robots.txt cache — when provided, spider() checks robots.txt before
	 * fetching and respects Crawl-delay directives.
	 */
	robotsCache?: RobotsCache;
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
		let res: Response;
		try {
			res = await fetch(url, {
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

	// Parse DOM — keep it for link/meta extraction before Readability mutates it.
	const dom = new JSDOM(html, { url });
	const doc = dom.window.document;

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
	const article = new Readability(doc).parse();
	if (!article) throw new Error(`Readability could not extract content from ${url} — the page may require JavaScript`);

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
	const tags = extractTags(doc, headings);

	// ---------------------------------------------------------------------------
	// Lean fast-path — skip turndown + chunking entirely
	// ---------------------------------------------------------------------------
	if (view === "lean") {
		const textContent = (article.textContent ?? "").trim();
		const wordCount = textContent.split(/\s+/).filter(Boolean).length;
		const chunkCount = Math.max(0, Math.floor(wordCount / CHUNK_TARGET_WORDS));

		// Hint when the page appears JS-rendered (empty body).
		if (wordCount === 0) {
			throw new Error(
				`No content extracted from ${url} — the page may require JavaScript rendering. ` +
					`Consider using a headless browser tool instead.`,
			);
		}

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
		return { ...lean, chunkCount };
	}

	// ---------------------------------------------------------------------------
	// Tree path — build semantic DOM tree, then also produce full markdown
	// ---------------------------------------------------------------------------
	if (view === "tree") {
		const tree = buildTree(article.content ?? "", url);
		const markdown = turndown.turndown(article.content ?? "");
		const wordCount = markdown.split(/\s+/).filter(Boolean).length;
		if (wordCount === 0) {
			throw new Error(
				`No content extracted from ${url} — the page may require JavaScript rendering. ` +
					`Consider using a headless browser tool instead.`,
			);
		}
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
	let markdown = turndown.turndown(article.content ?? "");
	const wordCount = markdown.split(/\s+/).filter(Boolean).length;

	// Hint when the page appears JS-rendered.
	if (wordCount === 0) {
		throw new Error(
			`No content extracted from ${url} — the page may require JavaScript rendering. ` +
				`Consider using a headless browser tool instead.`,
		);
	}

	// Apply token budget: truncate markdown to ~budget*4 chars, preserving
	// whole lines and appending a truncation notice.
	if (tokenBudget !== undefined) {
		const charLimit = tokenBudget * 4;
		if (markdown.length > charLimit) {
			const cut = markdown.lastIndexOf("\n", charLimit);
			markdown = `${markdown.slice(0, cut > 0 ? cut : charLimit)}\n\n… *[truncated to ~${tokenBudget} token budget]*`;
		}
	}

	const chunks = chunk(markdown, url);

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
		chunks,
		links,
		markdown,
	};
}
