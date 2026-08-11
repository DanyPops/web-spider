/**
 * web_fetch — fetch a URL/crawl/search the local cache. Thin authenticated
 * client of the Web Spider daemon: this file owns the tool contract
 * (parameters, output shapes, presentation) and routes to the daemon's
 * tool-agnostic operations; it performs no fetching, crawling, caching,
 * throttling, robots.txt checking, or Playwright rendering itself.
 *
 * This file reconstructs the exact historical web_fetch JSON content --
 * hint/status text, cache-list compaction, the "cache" field split into the
 * renderer details channel -- so the tool's observable behavior is
 * unchanged from before this file existed on its own.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import {
	createWebDetails,
	createWebResult,
	renderWebFetchCall,
	renderWebFetchResult,
	type WebPresentationDetails,
} from "./presentation.js";
import type { CallMeta, VehicleGateway } from "./vehicle-gateway.js";

// ---------------------------------------------------------------------------
// Parameters -- segregated by concern (ISP): each group below is a narrower
// slice a caller/handler can depend on instead of one flat 35-field object.
// Several fields legitimately serve more than one concern (e.g. `query` is
// read by cache-search, crawl, and tree; `limit` by cache-listing, cache-
// search, and search) -- grouped here by primary/first use, not claimed as
// disjoint. The composed `paramsSchema` below is the one actual wire schema,
// byte-identical to the original flat object.
// ---------------------------------------------------------------------------

/** url/format/query -- read across nearly every handler below. */
const coreParamsSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to fetch or crawl" })),
	format: Type.Optional(
		Type.Union(
			[
				Type.Literal("markdown"),
				Type.Literal("lean"),
				Type.Literal("links"),
				Type.Literal("highlights"),
				Type.Literal("tree"),
				Type.Literal("source"),
				Type.Literal("meta"),
			],
			{
				description:
					"markdown=full body (default), lean=outline only, links=hrefs, highlights=BM25F snippets, tree=DOM tree, source=normalized textual source with contentType/completeness metadata, meta=structured metadata only (Open Graph/Twitter Card/JSON-LD, no prose)",
			},
		),
	),
	query: Type.Optional(Type.String({ description: "Search text; required for format=highlights, optional for format=tree" })),
});

/** format=tree only. */
const treeParamsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "format=tree: dot-bracket node path, e.g. article.section[1].pre[0].code" })),
	topN: Type.Optional(Type.Number({ description: "format=tree with query: max hits (default 5)" })),
});

/** How to shape/bound extracted content -- shared by single-fetch and crawl. */
const contentShapingParamsSchema = Type.Object({
	rootSelector: Type.Optional(Type.String({ description: 'CSS selector to scope extraction to, e.g. "article"' })),
	excludeSelectors: Type.Optional(Type.String({ description: 'Comma-separated selectors to strip, e.g. "nav, footer"' })),
	tokenBudget: Type.Optional(Type.Number({ description: "Max ~tokens to return (~4 chars/token), capped at 10,000" })),
	pdfPageStart: Type.Optional(Type.Number({ description: "PDF only: 1-based inclusive first page (default 1)" })),
	pdfPageEnd: Type.Optional(Type.Number({ description: "PDF only: 1-based inclusive last page (maximum span 50)" })),
	enhanced: Type.Optional(
		Type.Boolean({
			description: "Force headless-browser rendering (default false; auto-falls back to it for JS-rendered pages)",
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout ms (default 30000)" })),
	ignoreRobots: Type.Optional(
		Type.Boolean({ description: "Explicit, audited bypass of robots.txt for this one request -- human-directed only" }),
	),
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Named per-site strategies to try before generic fetch+Readability, e.g. ["github"] or ["mediawiki","youtube"]. Built-in: llms-txt, markdown-suffix, github, mediawiki, youtube -- each queries the site\'s real API/data endpoint instead of scraping its rendered page, often solving what enhanced would otherwise be needed for. Unknown names error listing the real ones.',
		}),
	),
	maxCacheAgeMs: Type.Optional(
		Type.Number({
			description:
				"Reject an already-cached hit older than this many ms, treating it as a miss -- the fresh fetch is still written back to the shared cache normally, unlike rootSelector/enhanced/sources which bypass the cache entirely. 0 always refetches while still caching the result for later callers. Omit for the cache's own default TTL.",
		}),
	),
});

/** depth>0 crawl only. */
const crawlParamsSchema = Type.Object({
	depth: Type.Optional(Type.Number({ description: "BFS crawl depth from url (default 0 = single page)" })),
	maxPages: Type.Optional(Type.Number({ description: "Max pages when depth>0 (default 10)" })),
	sameDomain: Type.Optional(Type.Boolean({ description: "Follow only same-domain links when depth>0 (default true)" })),
	discoverOnly: Type.Optional(
		Type.Boolean({ description: "depth>0: URL map only -- pages are still fetched to discover links, but no content body is returned" }),
	),
	crawlUrls: Type.Optional(
		Type.Array(Type.String(), {
			description: "Selective second-phase crawl of exactly these URLs, no re-discovery -- routes to crawl even without depth>0",
		}),
	),
	maxTotalChars: Type.Optional(Type.Number({ description: "depth>0: total extracted-content character cap across the whole crawl" })),
	deadlineMs: Type.Optional(Type.Number({ description: "depth>0: wall-clock cap for the whole crawl, in milliseconds (default 120000)" })),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'depth>0: skip a discovered URL whose hostname matches (or is a subdomain of) any of these, e.g. ["ads.example.com"]. Independent of sameDomain -- both can be used together.',
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'depth>0: only follow a discovered URL whose hostname matches (or is a subdomain of) one of these, e.g. ["docs.example.com"].',
		}),
	),
});

/** No url: list/filter the local disk-backed cache. */
const cacheListingParamsSchema = Type.Object({
	grep: Type.Optional(Type.String({ description: "No url: substring filter over cached url/title/domain/description" })),
	domain: Type.Optional(Type.String({ description: 'No url: exact domain match, e.g. "github.com"' })),
	tag: Type.Optional(Type.String({ description: "No url: filter cache by auto-extracted tag" })),
	category: Type.Optional(Type.String({ description: "No url: filter cache by web_category-assigned category" })),
	fetchedAfter: Type.Optional(Type.Number({ description: "No url: epoch ms lower bound on cache time" })),
	fetchedBefore: Type.Optional(Type.Number({ description: "No url: epoch ms upper bound on cache time" })),
	publishedAfter: Type.Optional(Type.String({ description: "No url: ISO-8601 lower bound on the page's published date" })),
	publishedBefore: Type.Optional(Type.String({ description: "No url: ISO-8601 upper bound on the page's published date" })),
	sortBy: Type.Optional(
		Type.Union([Type.Literal("fetchedAt"), Type.Literal("publishedAt"), Type.Literal("url"), Type.Literal("domain")], {
			description: "No url: sort field (default fetchedAt)",
		}),
	),
	sortOrder: Type.Optional(
		Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "No url: sort direction (default desc)" }),
	),
	offset: Type.Optional(Type.Number({ description: "No url: pagination offset" })),
	limit: Type.Optional(Type.Number({ description: "No url: max results (default 20, cap 100 listing / 10 search)" })),
});

/** searchQuery: web search instead of a direct url. */
const searchParamsSchema = Type.Object({
	searchQuery: Type.Optional(
		Type.String({ description: "Web search text instead of url; returns ranked results with real URLs to fetch next" }),
	),
	siteFilter: Type.Optional(Type.String({ description: "searchQuery: restrict results to one domain" })),
	wantFullContent: Type.Optional(Type.Boolean({ description: "searchQuery: request full page content where the provider supports it" })),
});

/** The one actual wire schema -- composed from the concern-scoped pieces above. */
const paramsSchema = Type.Object({
	...coreParamsSchema.properties,
	...crawlParamsSchema.properties,
	...treeParamsSchema.properties,
	...cacheListingParamsSchema.properties,
	...contentShapingParamsSchema.properties,
	...searchParamsSchema.properties,
});

type Params = Static<typeof paramsSchema>;

// ---------------------------------------------------------------------------
// Local materialized view helpers
// ---------------------------------------------------------------------------

function pageItems(pages: Array<{ url: string; title?: string }>) {
	return pages.map((page) => ({ url: page.url, title: page.title ?? "" }));
}

function output(payload: unknown, details: WebPresentationDetails) {
	return createWebResult(payload, details);
}

/** Splits the daemon's "cache" hit/miss field out of a fetch result — historically renderer-only, never model content. */
function splitCache<T extends { cache?: "hit" | "miss" }>(result: T): { content: Omit<T, "cache">; cache: "hit" | "miss" | undefined } {
	const { cache, ...content } = result;
	return { content, cache };
}

/** Small local helper — omitEmpty was part of format.ts, which moved to the daemon package; kept here as the one remaining consumer (detail/content reshaping in this file only, not page formatting). */
function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)),
	);
}

// ---------------------------------------------------------------------------
// format=... dispatch for a single-page fetch (Strategy pattern, OCP): a new
// format is one new entry here, not a new branch in a growing if/else chain.
// Matches this monorepo's own established shape for open-ended dispatch --
// see web-spider/src/sources/registry.ts's own doc comment.
// ---------------------------------------------------------------------------

type FetchContent = Record<string, unknown>;
type SingleFetchFormat = Exclude<NonNullable<Params["format"]>, "tree">;
type SingleFetchHandlerParams = Pick<Params, "enhanced" | "query">;
type SingleFetchFormatHandler = (
	content: FetchContent,
	cache: "hit" | "miss" | undefined,
	url: string,
	params: SingleFetchHandlerParams,
) => ReturnType<typeof output>;

const SINGLE_FETCH_FORMAT_HANDLERS: Record<SingleFetchFormat, SingleFetchFormatHandler> = {
	lean(content, cache, url, params) {
		return output(
			content,
			createWebDetails({
				operation: "fetch",
				format: "lean",
				url,
				title: String(content.title ?? ""),
				wordCount: Number(content.wordCount ?? 0),
				cache,
				enhanced: params.enhanced,
			}),
		);
	},
	links(content, cache, url, params) {
		const links = (content.bodyLinks as unknown[] | undefined) ?? [];
		return output(
			content,
			createWebDetails({
				operation: "fetch",
				format: "links",
				url,
				title: String(content.title ?? ""),
				links: links.length,
				cache,
				enhanced: params.enhanced,
				items: links.map((link) => ({ url: (link as { href: string }).href, title: (link as { text: string }).text })),
			}),
		);
	},
	source(content, cache, url, params) {
		const truncated = content.truncated === true;
		return output(
			content,
			createWebDetails({
				operation: "fetch",
				format: "source",
				url,
				cache,
				enhanced: params.enhanced,
				truncated,
				complete: content.complete === true && !truncated,
			}),
		);
	},
	meta(content, cache, url, params) {
		const hasMetadata = content.openGraph !== undefined || content.twitterCard !== undefined || content.jsonLd !== undefined;
		const withHint = hasMetadata ? content : { ...content, hint: "No Open Graph, Twitter Card, or JSON-LD metadata found on this page." };
		return output(
			withHint,
			createWebDetails({
				operation: "fetch",
				format: "meta",
				status: hasMetadata ? "ok" : "empty",
				url,
				title: String(content.title ?? ""),
				cache,
				enhanced: params.enhanced,
			}),
		);
	},
	highlights(content, cache, url, params) {
		const hits = (content.hits as unknown[] | undefined) ?? [];
		const withHint = hits.length === 0 ? { ...content, hint: "No matches. Try broader terms or use format=markdown." } : content;
		return output(
			withHint,
			createWebDetails({
				operation: "fetch",
				format: "highlights",
				status: hits.length === 0 ? "empty" : "ok",
				url,
				title: String(content.title ?? ""),
				query: params.query,
				hits: hits.length,
				cache,
				enhanced: params.enhanced,
			}),
		);
	},
	markdown(content, cache, url, params) {
		const truncated = content.truncated === true;
		const withHint = truncated
			? {
					...content,
					hint: "Content was bounded. Use highlights, tree query/path, rootSelector, or a more specific request for complete evidence.",
				}
			: content;
		return output(
			withHint,
			createWebDetails({
				operation: "fetch",
				format: "markdown",
				url,
				title: String(content.title ?? ""),
				wordCount: Number(content.wordCount ?? 0),
				cache,
				enhanced: params.enhanced,
				truncated,
				complete: !truncated,
			}),
		);
	},
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/** Registers web_fetch. `gateway` is the one seam this module depends on instead of importing a concrete daemon client (DIP) -- see vehicle-gateway.ts. */
export function registerFetchTool(pi: ExtensionAPI, gateway: VehicleGateway): void {
	// -------------------------------------------------------------------------
	// Path handlers — each owns one execution branch. SRP: one reason to change.
	// -------------------------------------------------------------------------

	async function handleSearch(params: Params, callMeta: CallMeta) {
		const query = params.searchQuery ?? "";
		const result = await gateway.invoke<{
			query: string;
			results: Array<{ url: string; title: string; snippet: string; publishedAt?: string }>;
		}>(
			"search",
			{
				query,
				numResults: params.limit ?? 10,
				siteFilter: params.siteFilter,
				wantFullContent: params.wantFullContent,
			},
			callMeta,
		);
		gateway.log("info", "web search done", { query, hits: result.results.length });
		return output(
			{
				query: result.query,
				results: result.results,
				hint: "Use the url field from a result to fetch its full content with web_fetch(url=...).",
			},
			createWebDetails({
				operation: "search",
				format: "search",
				status: result.results.length === 0 ? "empty" : "ok",
				query,
				hits: result.results.length,
				items: result.results.map((r) => ({ url: r.url, title: r.title })),
			}),
		);
	}

	async function handleCacheListing(params: Params, callMeta: CallMeta) {
		const result = await gateway.invoke<{
			total: number;
			filtered: number;
			offset: number;
			limit: number;
			pages: Array<Record<string, unknown>>;
		}>(
			"cache.list",
			{
				grep: params.grep,
				domain: params.domain,
				tag: params.tag,
				category: params.category,
				fetchedAfter: params.fetchedAfter,
				fetchedBefore: params.fetchedBefore,
				publishedAfter: params.publishedAfter,
				publishedBefore: params.publishedBefore,
				sortBy: params.sortBy,
				sortOrder: params.sortOrder,
				offset: params.offset,
				limit: params.limit,
			},
			callMeta,
		);
		const remaining = result.filtered - result.offset - result.pages.length;
		const meta = omitEmpty({
			total: result.total,
			filtered: result.filtered !== result.total ? result.filtered : undefined,
			offset: result.offset || undefined,
			limit: result.limit,
			remaining: remaining > 0 ? remaining : undefined,
		});
		const items = pageItems(result.pages as Array<{ url: string; title?: string }>);
		return output(
			{ ...meta, pages: result.pages },
			createWebDetails({
				operation: "cache-list",
				format: "lean",
				status: result.pages.length === 0 ? "empty" : "ok",
				pages: result.filtered,
				cache: "listing",
				items,
				truncated: remaining > 0,
				complete: remaining <= 0,
			}),
		);
	}

	async function handleCacheSearch(params: Params, callMeta: CallMeta) {
		const result = await gateway.invoke<{
			query: string;
			pagesSearched: number;
			hits: Array<{ url: string; title: string; score: number; heading: string; text: string }>;
		}>(
			"cache.search",
			{
				query: params.query ?? "",
				limit: params.limit ?? 10,
			},
			callMeta,
		);

		if (result.pagesSearched === 0) {
			return output(
				{
					status: "empty",
					hint: "Local cache is empty. Fetch some pages first with depth=0 or depth>0.",
				},
				createWebDetails({
					operation: "cache-search",
					format: "highlights",
					status: "empty",
					query: params.query,
					pages: 0,
					hits: 0,
					cache: "search",
				}),
			);
		}

		// Historical content shape never included title on a hit — it stays daemon-side
		// (useful operational metadata for other consumers) but is stripped here.
		const hits = result.hits.map(({ url, heading, score, text }) => ({ url, heading, score, text }));
		return output(
			{
				...omitEmpty({ query: result.query, pagesSearched: result.pagesSearched }),
				hits,
				...(hits.length === 0
					? { hint: "No matches. Try broader terms, or list cached pages with web_fetch(format=lean) and no url." }
					: {}),
			},
			createWebDetails({
				operation: "cache-search",
				format: "highlights",
				status: hits.length === 0 ? "empty" : "ok",
				query: params.query,
				pages: result.pagesSearched,
				hits: hits.length,
				cache: "search",
				items: result.hits.map((h) => ({ url: h.url, title: h.title })),
			}),
		);
	}

	async function handleCrawl(params: Params, callMeta: CallMeta) {
		const fmt = params.format ?? "markdown";
		const depth = params.depth ?? 0;
		const url = params.url ?? "";

		const result = await gateway.invoke<Record<string, unknown>>(
			"crawl",
			{
				url,
				format: fmt,
				depth,
				maxPages: params.maxPages ?? 10,
				sameDomain: params.sameDomain,
				rootSelector: params.rootSelector,
				excludeSelectors: params.excludeSelectors,
				tokenBudget: params.tokenBudget,
				pdfPageStart: params.pdfPageStart,
				pdfPageEnd: params.pdfPageEnd,
				enhanced: params.enhanced,
				timeoutMs: params.timeoutMs,
				query: params.query,
				ignoreRobots: params.ignoreRobots,
				discoverOnly: params.discoverOnly,
				crawlUrls: params.crawlUrls,
				maxTotalChars: params.maxTotalChars,
				deadlineMs: params.deadlineMs,
				sources: params.sources,
				excludeDomains: params.excludeDomains,
				includeDomains: params.includeDomains,
				maxCacheAgeMs: params.maxCacheAgeMs,
			},
			callMeta,
		);
		const errors = typeof result.errors === "number" ? result.errors : 0;

		if (fmt === "highlights") {
			const hits = (result.hits as unknown[] | undefined) ?? [];
			return output(
				result,
				createWebDetails({
					operation: "crawl",
					format: "highlights",
					url,
					query: params.query,
					depth,
					pages: typeof result.pagesSearched === "number" ? result.pagesSearched : 0,
					hits: hits.length,
					errors,
					items: pageItems(hits as Array<{ url: string; title?: string }>),
				}),
			);
		}

		const pages = (result.pages as Array<Record<string, unknown>> | undefined) ?? [];
		const content =
			fmt === "lean"
				? result
				: {
						...result,
						// Historical guidance names the web_fetch tool specifically — added here,
						// not by the daemon, which also serves the tool-agnostic CLI.
						note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
					};

		return output(
			content,
			createWebDetails({
				operation: "crawl",
				format: fmt === "lean" ? "lean" : "markdown",
				url,
				depth,
				pages: typeof result.pagesFound === "number" ? result.pagesFound : pages.length,
				errors,
				items: pageItems(pages as Array<{ url: string; title?: string }>),
			}),
		);
	}

	async function handleTreeFormat(params: Params, callMeta: CallMeta) {
		const url = params.url ?? "";
		try {
			if (params.path) {
				const node = await gateway.invoke<{ found?: false; path?: string; tag?: string } & Record<string, unknown>>(
					"fetch",
					{
						url,
						format: "tree",
						path: params.path,
						rootSelector: params.rootSelector,
						excludeSelectors: params.excludeSelectors,
						enhanced: params.enhanced,
						ignoreRobots: params.ignoreRobots,
						sources: params.sources,
						maxCacheAgeMs: params.maxCacheAgeMs,
					},
					callMeta,
				);
				if (node.found === false) {
					return output(
						{ found: false, path: params.path, hint: "Inspect the full tree or query it to find a valid path." },
						createWebDetails({
							operation: "tree-path",
							format: "tree",
							status: "empty",
							url,
							path: params.path,
						}),
					);
				}
				return output(node, createWebDetails({ operation: "tree-path", format: "tree", url, path: String(node.path ?? params.path) }));
			}

			if (params.query?.trim()) {
				const result = await gateway.invoke<{
					url: string;
					query: string;
					hits: Array<{ path: string; tag: string; score: number; snippet: string }>;
				}>(
					"fetch",
					{
						url,
						format: "tree",
						query: params.query,
						topN: params.topN,
						rootSelector: params.rootSelector,
						excludeSelectors: params.excludeSelectors,
						enhanced: params.enhanced,
						ignoreRobots: params.ignoreRobots,
						sources: params.sources,
						maxCacheAgeMs: params.maxCacheAgeMs,
					},
					callMeta,
				);
				return output(
					omitEmpty({ url: result.url, query: result.query, hits: result.hits.map((h) => omitEmpty({ ...h })) }),
					createWebDetails({
						operation: "tree-query",
						format: "tree",
						status: result.hits.length === 0 ? "empty" : "ok",
						url,
						query: params.query,
						hits: result.hits.length,
						items: result.hits.map((hit) => ({ url, title: `${hit.tag} · ${hit.path}` })),
					}),
				);
			}

			const tree = await gateway.invoke<Record<string, unknown>>(
				"fetch",
				{
					url,
					format: "tree",
					rootSelector: params.rootSelector,
					excludeSelectors: params.excludeSelectors,
					enhanced: params.enhanced,
					ignoreRobots: params.ignoreRobots,
					sources: params.sources,
					maxCacheAgeMs: params.maxCacheAgeMs,
				},
				callMeta,
			);
			return output(tree, createWebDetails({ operation: "tree-full", format: "tree", url }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`tree fetch failed: ${message}`);
		}
	}

	async function handleSinglePage(params: Params, callMeta: CallMeta) {
		const fmt = params.format ?? "markdown";
		const url = params.url ?? "";

		if (fmt === "tree") return handleTreeFormat(params, callMeta);

		const raw = await gateway.invoke<Record<string, unknown> & { cache?: "hit" | "miss"; blocked?: boolean }>(
			"fetch",
			{
				url,
				format: fmt,
				rootSelector: params.rootSelector,
				excludeSelectors: params.excludeSelectors,
				tokenBudget: params.tokenBudget,
				pdfPageStart: params.pdfPageStart,
				pdfPageEnd: params.pdfPageEnd,
				enhanced: params.enhanced,
				timeoutMs: params.timeoutMs,
				query: params.query,
				ignoreRobots: params.ignoreRobots,
				sources: params.sources,
				maxCacheAgeMs: params.maxCacheAgeMs,
			},
			callMeta,
		);

		if (raw.blocked === true) {
			return output(
				{
					blocked: true,
					url,
					reason: "robots.txt",
					hint: "The site's robots.txt disallows crawling this URL. Try a different path or domain.",
				},
				createWebDetails({ operation: "fetch", format: fmt, status: "blocked", url, blockedBy: "robots.txt" }),
			);
		}

		const { content, cache } = splitCache(raw);
		return SINGLE_FETCH_FORMAT_HANDLERS[fmt](content, cache, url, params);
	}

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: [
			"Fetch a URL and return its content, or crawl to a given depth.",
			"Unsure a URL exists? Pass searchQuery instead of url -- never guess article slugs or paths -- then fetch the real URL that comes back.",
			"",
			"Omit url to query the local disk-backed cache instead of the network: no query lists cached pages, query=X runs BM25F full-text search. grep/domain/tag/category/fetchedAfter/fetchedBefore/publishedAfter/publishedBefore/sortBy/sortOrder/offset/limit filter and paginate that listing.",
			"",
			"depth=0 (default) fetches one URL, free on a cache hit. depth>0 BFS-crawls up to maxPages and caches every page.",
			"",
			"format trades the default full markdown for targeted views (lean/links/highlights/tree/source/meta) -- see the format parameter. source is normalized textual content, not byte-identical wire data. meta returns only Open Graph/Twitter Card/JSON-LD structured metadata, never prose -- deliberately separate from markdown/lean/tree so a page's schema.org payload never inflates an ordinary fetch's token cost. rootSelector/excludeSelectors/tokenBudget scope and cap what's extracted. pdfPageStart/pdfPageEnd select a bounded 1-based PDF range.",
			"",
			"enhanced=true forces headless-browser rendering for SPAs/JS-heavy/bot-gated pages; default auto-falls back to it when needed.",
			"",
			"sources=[...] tries named per-site strategies (llms-txt, markdown-suffix, github, mediawiki, youtube) before generic fetch+Readability -- each queries a real API/data endpoint (e.g. YouTube's oEmbed, GitHub's REST API, MediaWiki's action=parse) instead of scraping the rendered page, often cheaper and more reliable than enhanced for a site one of these covers.",
			"",
			"A depth>0 crawl best-first orders content-likely pages first and classifies each one's pageType (article/list/js_shell) with contentOk. discoverOnly=true returns a URL map without content bodies. crawlUrls=[...] selectively (re-)crawls exactly those URLs, no re-discovery. maxTotalChars/deadlineMs bound total extracted size and wall-clock time; nextAction reports why a crawl stopped.",
			"",
			"excludeDomains/includeDomains=[...] scope a depth>0 crawl's frontier by hostname (with subdomains), independent of and composable with sameDomain.",
			"",
			"maxCacheAgeMs rejects an already-cached hit older than this many ms without disqualifying the request from the cache entirely -- the fresh fetch is still cached normally for later callers, unlike rootSelector/enhanced/sources which bypass the cache in both directions.",
			"",
			"Requests are rate-limited per domain and back off on 429/503. robots.txt is checked before every fetch; ignoreRobots is an explicit, audited, human-directed bypass for one request -- never a default.",
		].join("\n"),
		promptSnippet: "Fetch URL: format=markdown/lean/links/highlights/tree/source, depth, rootSelector, tokenBudget, PDF page range",
		parameters: paramsSchema,
		renderCall(args, theme, context) {
			return renderWebFetchCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebFetchResult(result, options, theme, context);
		},

		// -------------------------------------------------------------------------
		// Router — routes to the correct path handler. One reason to change: routing
		// logic. Business logic lives in the daemon; this file's handlers only
		// shape daemon operation results into the tool's historical contract.
		// -------------------------------------------------------------------------
		async execute(toolCallId, params, signal, _onUpdate, context) {
			try {
				const callMeta: CallMeta = { toolName: "web_fetch", toolCallId, signal, context };
				if (params.searchQuery?.trim()) return await handleSearch(params, callMeta);

				if (!params.url) {
					if (params.query?.trim()) return await handleCacheSearch(params, callMeta);
					return await handleCacheListing(params, callMeta);
				}

				if ((params.depth ?? 0) > 0 || (params.crawlUrls?.length ?? 0) > 0) return await handleCrawl(params, callMeta);

				return await handleSinglePage(params, callMeta);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_fetch failed: ${message}`);
			}
		},
	});
}
