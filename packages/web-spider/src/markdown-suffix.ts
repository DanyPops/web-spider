/**
 * .md URL-suffix discovery strategy — for a documentation-shaped URL, try
 * fetching a `.md` variant of the exact same page before falling back to
 * fetch+Readability on the original HTML.
 *
 * Verified real and working this session against docs.aws.amazon.com:
 * .../AmazonS3/latest/userguide/Welcome.html has a genuine sibling at
 * .../AmazonS3/latest/userguide/Welcome.md returning 200 text/markdown.
 * An extensionless path (.../Welcome) 301-redirects to the .html version,
 * confirming .html is the real canonical extension to substitute from.
 * Both Coveo's and Algolia's own documentation sites independently mention
 * the identical "append .md to this page's URL" convention, suggesting it
 * is spreading beyond AWS.
 *
 * Unlike llms.txt (a site-wide index probed at the origin), this strategy
 * operates on the *specific* URL requested — it targets the same page, not
 * a different resource.
 */
import type { IHttpClient } from "./ports.js";

export interface ProbeMarkdownVariantOptions {
	/** ms before aborting the probe request (default 10 000). */
	timeoutMs?: number;
	userAgent?: string;
}

export interface MarkdownVariantProbeResult {
	/** The .md URL that was actually fetched. */
	url: string;
	content: string;
	/** Raw Content-Type header from the response, if any. */
	contentType: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";
const HTML_EXTENSION = /\.html?$/i;

/**
 * Derives the .md sibling URL for a documentation-shaped page, or null when
 * no sensible variant applies (already .md, or has some other extension
 * this convention doesn't cover, e.g. .pdf/.json).
 */
export function deriveMarkdownVariantUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.pathname.toLowerCase().endsWith(".md")) return null; // already markdown

	if (HTML_EXTENSION.test(parsed.pathname)) {
		parsed.pathname = parsed.pathname.replace(HTML_EXTENSION, ".md");
		return parsed.toString();
	}

	const hasOtherExtension = /\.[a-z0-9]+$/i.test(parsed.pathname);
	if (hasOtherExtension) return null; // .pdf, .json, etc. -- not this convention's shape

	// Extensionless path (with or without a trailing slash) -- append .md.
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}.md`;
	return parsed.toString();
}

/**
 * Probes the .md variant of a specific URL. Returns null (never throws) for
 * anything that isn't a clean text-based 200 -- including the case where
 * deriveMarkdownVariantUrl finds no sensible variant to try at all.
 */
export async function probeMarkdownVariant(
	url: string,
	httpClient: IHttpClient,
	options: ProbeMarkdownVariantOptions = {},
): Promise<MarkdownVariantProbeResult | null> {
	const variantUrl = deriveMarkdownVariantUrl(url);
	if (!variantUrl) return null;

	const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await httpClient.fetch({
			url: variantUrl,
			signal: controller.signal,
			headers: { "User-Agent": userAgent, Accept: "text/markdown, text/plain, */*" },
		});
		if (!res.ok) return null;
		const contentType = res.headers.get("content-type");
		if (contentType?.toLowerCase().includes("html")) return null; // SPA soft-404 or redirected back to HTML
		const content = await res.text();
		if (!content.trim()) return null;
		return { url: variantUrl, content, contentType };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
