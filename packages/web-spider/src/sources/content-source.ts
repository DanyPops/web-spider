/**
 * ContentSourceStrategy — the extension point for "query a site's real data
 * endpoint instead of scraping its rendered page" strategies (see
 * docs/content-source-strategies.md).
 *
 * Distinct from ContentExtractor (../fetch/content-extractor.ts,
 * docs/content-extractors.md): a ContentExtractor converts an
 * already-fetched response and performs no I/O of its own. A
 * ContentSourceStrategy IS a fetch — it decides whether a URL is its shape
 * (`matches`, synchronous, no network), then performs whatever network
 * work is needed to resolve a better resource for that URL (`fetch`,
 * async), handing back a plain text/HTML/markdown resource for the normal
 * extraction pipeline to run on exactly as if it had come from a plain
 * GET. Returns null (never throws) on any miss — wrong URL shape, site
 * doesn't actually run the expected platform, API error, rate limit — so
 * `spider()` can cleanly fall through to the next strategy, and ultimately
 * to a plain fetch, with zero special-casing at the call site.
 *
 * This is the seam a new per-site adapter (Wikipedia/MediaWiki, GitHub,
 * YouTube, ...) plugs into without editing `spider()` itself: implement
 * the two methods below, register it (see ./registry.ts), or just pass it
 * directly via `SpiderOptions.contentSources`.
 */
import type { IHttpClient } from "../ports.js";

/** Everything a strategy's fetch() needs, without granting it spider()'s full option surface. */
export interface ContentSourceRequest {
	/** The URL passed to spider() — the same value already given to matches(). */
	url: string;
	httpClient: IHttpClient;
	timeoutMs: number;
	userAgent: string;
}

export interface ContentSourceResult {
	/**
	 * The resource URL the extraction pipeline should treat as `url`/`domain`.
	 * Equal to the request's url when the strategy is only swapping *mechanism*
	 * for the same resource (GitHub's API vs. its rendered page, MediaWiki's
	 * action=parse vs. the rendered wiki page). Different when the strategy
	 * resolves to a genuinely different resource for the same intent
	 * (llms.txt's site-wide index, a page's own .md sibling).
	 */
	url: string;
	/** Fed to the same content-type classifier the normal fetch path uses (see ../fetch/content-type.ts). */
	contentType: string;
	text: string;
	/** Overrides the extracted page's title when the strategy already knows it authoritatively (GitHub, MediaWiki). Omit to let normal extraction derive it. */
	title?: string;
}

/**
 * A pluggable per-site/per-convention Strategy. Implementations live under
 * `src/sources/`; `matches()` should be cheap and synchronous (a URL-shape
 * check), leaving all network cost to `fetch()`, which callers only pay
 * once `matches()` has already said yes.
 */
export interface ContentSourceStrategy {
	/** Stable, human-readable name. Surfaced as `viaStrategy` on a hit. */
	readonly name: string;
	/** Synchronous URL-shape check — no network. */
	matches(url: string): boolean;
	/**
	 * Resolve `req.url` to a better resource. Returns null (never throws) for
	 * anything that isn't a genuine hit: wrong platform, API/network error,
	 * rate limit, empty content.
	 */
	fetch(req: ContentSourceRequest): Promise<ContentSourceResult | null>;
}
