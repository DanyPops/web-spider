/**
 * llms.txt discovery strategy — the cheapest, most general query strategy:
 * one HTTP GET at a site's origin, no auth, no per-platform detection logic.
 *
 * llms.txt is an emerging convention (proposed 2024 by Jeremy Howard) where a
 * site publishes a structured Markdown content index at its root. Verified
 * real and high-value this session: AWS's docs.aws.amazon.com/llms.txt
 * indexes hundreds of service doc guides; a farmed directory
 * (github.com/thedaviddias/llms-txt-hub) lists 600+ developer-tools and
 * infrastructure-cloud adopters including Anthropic, Cloudflare, Docker,
 * Vercel, Supabase, Netlify, and Linear.
 *
 * Real-world adoption is genuinely mixed (an Ahrefs study of 137K sites found
 * only ~28% publish one at all), so this is deliberately a cheap probe that
 * fails closed to "not found" rather than an assumption baked into the
 * default fetch path.
 */
import type { IHttpClient } from "./ports.js";

export interface ProbeLlmsTxtOptions {
	/** ms before aborting each probe request (default 10 000). */
	timeoutMs?: number;
	userAgent?: string;
	/**
	 * Also probe /llms-full.txt (full content embedded, not just an index of
	 * links) if /llms.txt itself is not found. Default: false — llms.txt
	 * alone is the common case and keeps this a single request.
	 */
	includeFullVariant?: boolean;
}

export type LlmsTxtVariant = "llms.txt" | "llms-full.txt";

export interface LlmsTxtProbeResult {
	/** The llms.txt (or llms-full.txt) URL that was actually fetched — not the URL originally passed in. */
	url: string;
	variant: LlmsTxtVariant;
	content: string;
	/** Raw Content-Type header from the response, if any. */
	contentType: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "web-spider/0.1 (AI agent research tool; +https://github.com/DanyPops)";

/**
 * Probes a target URL's origin for a real llms.txt. Returns null (never
 * throws for a missing/broken llms.txt) so callers can cheaply fall back to
 * their normal fetch path.
 *
 * Guards against a real false-positive risk: many SPAs return 200 text/html
 * (their app shell) for any unmatched path rather than a real 404 -- a
 * genuine llms.txt is always text-based, so an HTML content-type is treated
 * as "not found," not a hit.
 */
export async function probeLlmsTxt(
	targetUrl: string,
	httpClient: IHttpClient,
	options: ProbeLlmsTxtOptions = {},
): Promise<LlmsTxtProbeResult | null> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = DEFAULT_USER_AGENT, includeFullVariant = false } = options;

	let origin: string;
	try {
		origin = new URL(targetUrl).origin;
	} catch {
		return null;
	}

	const candidates: Array<{ url: string; variant: LlmsTxtVariant }> = [{ url: `${origin}/llms.txt`, variant: "llms.txt" }];
	if (includeFullVariant) candidates.push({ url: `${origin}/llms-full.txt`, variant: "llms-full.txt" });

	for (const candidate of candidates) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await httpClient.fetch({
				url: candidate.url,
				signal: controller.signal,
				headers: { "User-Agent": userAgent, Accept: "text/plain, text/markdown, */*" },
			});
			if (!res.ok) continue;
			const contentType = res.headers.get("content-type");
			if (contentType?.toLowerCase().includes("html")) continue; // SPA soft-404, not a real llms.txt
			const content = await res.text();
			if (!content.trim()) continue;
			return { url: candidate.url, variant: candidate.variant, content, contentType };
		} catch {
			// try the next candidate
		} finally {
			clearTimeout(timer);
		}
	}
	return null;
}
