/**
 * @danypops/pi-web-spider — Pi extension exposing web_fetch.
 *
 * Thin authenticated client of the Web Spider daemon (@danypops/web-spider-daemon):
 * this file owns the tool contract (parameters, output shapes, presentation)
 * and daemon connection lifecycle; it no longer performs any fetching,
 * crawling, caching, throttling, robots.txt checking, or Playwright
 * rendering itself — the daemon does all of that.
 *
 * The daemon's operations return tool-agnostic data (see e.g.
 * fetch-service.ts/crawl-service.ts's own doc comments); this file
 * reconstructs the exact historical web_fetch JSON content — hint/status
 * text, cache-list compaction, the "cache" field split into the renderer
 * details channel — so the tool's observable behavior is unchanged.
 *
 * Install: pi install git:github.com/DanyPops/web-spider
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { DETAILS_MAX_ITEMS, DETAILS_VERSION } from "./constants.js";
import {
	createWebDetails,
	createWebResult,
	renderWebFetchCall,
	renderWebFetchResult,
	type WebPresentationDetails,
} from "./presentation.js";
import { createQuotesDetails, createQuotesResult, renderWebQuotesCall, renderWebQuotesResult } from "./quotes-presentation.js";
import { invokeWebSpiderVehicleOperation } from "./retrying-client.js";
import {
	createSessionActDetails,
	createSessionLifecycleDetails,
	createSessionListDetails,
	renderWebSessionCall,
	renderWebSessionResult,
} from "./session-presentation.js";
import { registerWebSpiderUsageCommand } from "./usage-command.js";

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	// Diagnostics go only to a file — never to stdout/stderr, which belong to Pi's TUI.
	const diagPath = process.env.WEB_SPIDER_DIAG_PATH ?? join(homedir(), ".cache", "web-spider", "diag.log");
	const diag = (entry: Record<string, unknown>) => {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		try {
			mkdirSync(dirname(diagPath), { recursive: true });
			appendFileSync(diagPath, `${line}\n`);
		} catch {
			/* best-effort */
		}
	};
	const log = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => {
		diag({ level, msg, ...(extra !== undefined ? { extra } : {}) });
	};

	type Params = Static<typeof paramsSchema>;

	/** Every operation goes through invokeVehicle() below -- every web-spider operation has migrated onto the real Vehicle protocol (task 4057390d), carrying whichever tool actually dispatched it (web_fetch/web_session/web_category), its toolCallId, abort signal, and ExtensionContext. */
	type CallMeta = { toolName: string; toolCallId: string; signal?: AbortSignal; context: ExtensionContext };

	/**
	 * Routes an operation through invokeWebSpiderVehicleOperation(), giving
	 * every caller the same cross-cutting policy (activity broadcasting, the
	 * /safety gate, approval retry) uniformly.
	 */
	async function invokeVehicle<T = unknown>(operation: string, input: Record<string, unknown>, callMeta: CallMeta): Promise<T> {
		try {
			const result = await invokeWebSpiderVehicleOperation(operation, input, callMeta);
			return result.details.output as T;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("error", "daemon operation failed", { operation, error: message });
			throw error;
		}
	}

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

	// ---------------------------------------------------------------------------
	// Path handlers — each owns one execution branch. SRP: one reason to change.
	// ---------------------------------------------------------------------------

	async function handleSearch(params: Params, callMeta: CallMeta) {
		const query = params.searchQuery ?? "";
		const result = await invokeVehicle<{
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
		log("info", "web search done", { query, hits: result.results.length });
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
		const result = await invokeVehicle<{
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
		const result = await invokeVehicle<{
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

		const result = await invokeVehicle<Record<string, unknown>>(
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
				const node = await invokeVehicle<{ found?: false; path?: string; tag?: string } & Record<string, unknown>>(
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
				const result = await invokeVehicle<{
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

			const tree = await invokeVehicle<Record<string, unknown>>(
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

		const raw = await invokeVehicle<Record<string, unknown> & { cache?: "hit" | "miss"; blocked?: boolean }>(
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

		if (fmt === "lean") {
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
		}

		if (fmt === "links") {
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
		}

		if (fmt === "source") {
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
		}

		if (fmt === "meta") {
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
		}

		if (fmt === "highlights") {
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
		}

		// markdown (default)
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
	}

	// ---------------------------------------------------------------------------
	// Tool registration
	// ---------------------------------------------------------------------------

	// Defined here so Params = Static<typeof paramsSchema> resolves concretely
	// rather than being derived through registerTool's unresolved generic.
	const paramsSchema = Type.Object({
		url: Type.Optional(Type.String({ description: "URL to fetch or crawl" })),

		depth: Type.Optional(Type.Number({ description: "BFS crawl depth from url (default 0 = single page)" })),
		maxPages: Type.Optional(Type.Number({ description: "Max pages when depth>0 (default 10)" })),
		sameDomain: Type.Optional(Type.Boolean({ description: "Follow only same-domain links when depth>0 (default true)" })),

		enhanced: Type.Optional(
			Type.Boolean({
				description: "Force headless-browser rendering (default false; auto-falls back to it for JS-rendered pages)",
			}),
		),

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
		path: Type.Optional(Type.String({ description: "format=tree: dot-bracket node path, e.g. article.section[1].pre[0].code" })),
		topN: Type.Optional(Type.Number({ description: "format=tree with query: max hits (default 5)" })),

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

		rootSelector: Type.Optional(Type.String({ description: 'CSS selector to scope extraction to, e.g. "article"' })),
		excludeSelectors: Type.Optional(Type.String({ description: 'Comma-separated selectors to strip, e.g. "nav, footer"' })),
		tokenBudget: Type.Optional(Type.Number({ description: "Max ~tokens to return (~4 chars/token), capped at 10,000" })),
		pdfPageStart: Type.Optional(Type.Number({ description: "PDF only: 1-based inclusive first page (default 1)" })),
		pdfPageEnd: Type.Optional(Type.Number({ description: "PDF only: 1-based inclusive last page (maximum span 50)" })),
		searchQuery: Type.Optional(
			Type.String({ description: "Web search text instead of url; returns ranked results with real URLs to fetch next" }),
		),
		siteFilter: Type.Optional(Type.String({ description: "searchQuery: restrict results to one domain" })),
		wantFullContent: Type.Optional(Type.Boolean({ description: "searchQuery: request full page content where the provider supports it" })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout ms (default 30000)" })),
		ignoreRobots: Type.Optional(
			Type.Boolean({ description: "Explicit, audited bypass of robots.txt for this one request -- human-directed only" }),
		),
		discoverOnly: Type.Optional(
			Type.Boolean({ description: "depth>0: URL map only -- pages are still fetched to discover links, but no content body is returned" }),
		),
		crawlUrls: Type.Optional(
			Type.Array(Type.String(), {
				description: "Selective second-phase crawl of exactly these URLs, no re-discovery -- routes to crawl even without depth>0",
			}),
		),
		maxTotalChars: Type.Optional(Type.Number({ description: "depth>0: total extracted-content character cap across the whole crawl" })),
		deadlineMs: Type.Optional(
			Type.Number({ description: "depth>0: wall-clock cap for the whole crawl, in milliseconds (default 120000)" }),
		),
		sources: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Named per-site strategies to try before generic fetch+Readability, e.g. ["github"] or ["mediawiki","youtube"]. Built-in: llms-txt, markdown-suffix, github, mediawiki, youtube -- each queries the site\'s real API/data endpoint instead of scraping its rendered page, often solving what enhanced would otherwise be needed for. Unknown names error listing the real ones.',
			}),
		),
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
		maxCacheAgeMs: Type.Optional(
			Type.Number({
				description:
					"Reject an already-cached hit older than this many ms, treating it as a miss -- the fresh fetch is still written back to the shared cache normally, unlike rootSelector/enhanced/sources which bypass the cache entirely. 0 always refetches while still caching the result for later callers. Omit for the cache's own default TTL.",
			}),
		),
	});

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

	// ---------------------------------------------------------------------------
	// web_session — tmux-style persistent browser sessions. A thin, faithful
	// pass-through to the daemon's session.create/list/close/act operations,
	// deliberately kept separate from web_fetch rather than overloading its
	// contract (web_fetch's contract must never change). See daemon-side
	// session-service.ts for the actual behavior/safety guarantees this tool
	// exposes but does not reimplement:
	//   - one owned Playwright browser process per named session, isolated
	//     from the operator's own browser and every other session.
	//   - snapshotVersion is a deliberate safety mechanism, not busywork: the
	//     daemon fails closed (a StaleSnapshotError) if the page navigated or
	//     changed since the caller last observed it. This tool does NOT track
	//     snapshotVersion on the caller's behalf — every act() response
	//     returns the current value; pass it back on the next call. Removing
	//     this friction here would silently undermine the reason it exists.
	//   - every act() call is journaled (content-free — selectors and enum
	//     values only, never typed text, scripts, or page content).
	// ---------------------------------------------------------------------------
	const sessionParamsSchema = Type.Object({
		operation: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("close"), Type.Literal("act")], {
			description: "create/list/close a named session, or act on one",
		}),
		name: Type.Optional(Type.String({ description: "Session name (create/close/act)" })),
		forceChromeChannel: Type.Optional(
			Type.Boolean({ description: "create: use the full installed Chrome channel instead of the default headless shell" }),
		),
		snapshotVersion: Type.Optional(
			Type.Number({
				description:
					"act, required: expected snapshot version, from the previous response (create returns 0). " +
					"A stale value fails closed rather than acting on a page that navigated underneath you.",
			}),
		),
		action: Type.Optional(
			Type.Union(
				[
					Type.Literal("navigate"),
					Type.Literal("click"),
					Type.Literal("hover"),
					Type.Literal("pressKey"),
					Type.Literal("type"),
					Type.Literal("select"),
					Type.Literal("waitFor"),
					Type.Literal("queryText"),
					Type.Literal("readTable"),
					Type.Literal("snapshot"),
					Type.Literal("handleDialog"),
					Type.Literal("downloads"),
					Type.Literal("consoleMessages"),
					Type.Literal("networkRequests"),
					Type.Literal("tabs"),
					Type.Literal("eval"),
					Type.Literal("screenshot"),
				],
				{
					description:
						"act, required. navigate/click/hover/pressKey/type/select act on the page (track snapshotVersion). " +
						"waitFor blocks for a condition instead of guessing a delay. queryText/readTable return structured " +
						"data. snapshot returns a YAML a11y tree -- prefer it over screenshot for page structure. " +
						"handleDialog arms accept/dismiss for the next dialog. downloads/consoleMessages/networkRequests read " +
						"captured session activity. tabs manages multiple tabs. eval runs arbitrary JavaScript -- prefer the " +
						"structured actions above when they fit. screenshot returns a PNG.",
				},
			),
		),
		url: Type.Optional(Type.String({ description: "navigate: URL to load. tabs (new): optional URL for the new tab." })),
		selector: Type.Optional(
			Type.String({
				description:
					"CSS selector for click/hover/type/select/waitFor/queryText/readTable/snapshot(scope)/screenshot(scope); optional focus target for pressKey.",
			}),
		),
		text: Type.Optional(Type.String({ description: "type: text to type as real keystrokes. waitFor: text to wait for." })),
		clear: Type.Optional(Type.Boolean({ description: "type: clear existing content first (default true)" })),
		value: Type.Optional(Type.String({ description: "select: match an option by its value attribute" })),
		label: Type.Optional(Type.String({ description: "select: match an option by its visible label" })),
		loadState: Type.Optional(
			Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")], {
				description: "waitFor: navigation state to wait for instead of a selector/text condition",
			}),
		),
		state: Type.Optional(
			Type.Union([Type.Literal("visible"), Type.Literal("hidden"), Type.Literal("attached"), Type.Literal("detached")], {
				description: "waitFor: element state to wait for alongside selector/text (default visible)",
			}),
		),
		script: Type.Optional(Type.String({ description: "eval: JavaScript to run in the page; returns its JSON-serializable result" })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-action timeout ms (Playwright's own default applies when omitted)" })),
		key: Type.Optional(Type.String({ description: 'pressKey: key to press, e.g. "Enter", "Escape", "Tab", "ArrowLeft"' })),
		fullPage: Type.Optional(
			Type.Boolean({ description: "screenshot: capture the whole scrollable page instead of the viewport; not valid with selector" }),
		),
		scale: Type.Optional(
			Type.Union([Type.Literal("css"), Type.Literal("device")], {
				description: "screenshot: image resolution -- css pixels (default) or real device pixel ratio",
			}),
		),
		depth: Type.Optional(Type.Number({ description: "snapshot: limit the accessibility tree's depth" })),
		boxes: Type.Optional(Type.Boolean({ description: "snapshot: include each node's viewport-relative bounding box" })),
		mode: Type.Optional(
			Type.Union([Type.Literal("ai"), Type.Literal("default")], {
				description:
					'snapshot: "ai" adds element references, doesn\'t wait for a matching element, and includes <iframe> content (default "default")',
			}),
		),
		accept: Type.Optional(Type.Boolean({ description: "handleDialog, required: accept (true) or dismiss (false) the next native dialog" })),
		promptText: Type.Optional(Type.String({ description: "handleDialog: text to answer a prompt() dialog with" })),
		includeStatic: Type.Optional(Type.Boolean({ description: "networkRequests: include successful static resources too (default false)" })),
		tabOperation: Type.Optional(
			Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("close"), Type.Literal("select")], {
				description:
					"tabs, required: list open tabs; new opens one; close closes one (default active); select switches (tabIndex required)",
			}),
		),
		tabIndex: Type.Optional(
			Type.Number({ description: "tabs: 0-based tab index; required for select, optional for close (default active)" }),
		),
	});

	type SessionParams = Static<typeof sessionParamsSchema>;

	interface SessionActResult {
		name: string;
		action: string;
		snapshotVersion: number;
		result?: unknown;
		screenshotBase64?: string;
	}

	pi.registerTool({
		name: "web_session",
		label: "Web Session",
		description: [
			"Persistent, named browser sessions for pages that need real interaction -- typing, selecting dropdowns, waiting on async results, reading tables -- rather than a single fetch.",
			"tmux-session semantics: create once, act on the same page repeatedly, close when done. hover is the only way to trigger CSS :hover-revealed menus/tooltips. Always close sessions you no longer need.",
			"",
			"Every act() response returns snapshotVersion; pass it back on your next call for that session. A stale value is rejected rather than silently acting on a page that may have navigated underneath you. create returns snapshotVersion:0.",
		].join("\n"),
		promptSnippet:
			"Persistent browser sessions: create/act(navigate|click|hover|pressKey|type|select|waitFor|queryText|readTable|snapshot|handleDialog|downloads|consoleMessages|networkRequests|tabs|eval|screenshot)/list/close",
		parameters: sessionParamsSchema,
		renderCall(args, theme, context) {
			return renderWebSessionCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebSessionResult(result, options, theme, context);
		},
		async execute(toolCallId, params: SessionParams, signal, _onUpdate, context) {
			const callMeta: CallMeta = { toolName: "web_session", toolCallId, signal, context };
			try {
				if (params.operation === "create") {
					if (!params.name) throw new Error("name is required for operation=create");
					const result = await invokeVehicle<{ name: string; snapshotVersion: number; closed: boolean }>(
						"session.create",
						{ name: params.name, forceChromeChannel: params.forceChromeChannel },
						callMeta,
					);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionLifecycleDetails("create", result.name, { snapshotVersion: result.snapshotVersion }),
					};
				}
				if (params.operation === "list") {
					const result = await invokeVehicle<{ sessions: Array<{ name: string; closed: boolean }> }>("session.list", {}, callMeta);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionListDetails(result.sessions),
					};
				}
				if (params.operation === "close") {
					if (!params.name) throw new Error("name is required for operation=close");
					const result = await invokeVehicle<{ name: string; closed: true }>("session.close", { name: params.name }, callMeta);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionLifecycleDetails("close", result.name, { closed: true }),
					};
				}

				// act
				if (!params.name) throw new Error("name is required for operation=act");
				if (params.snapshotVersion === undefined) throw new Error("snapshotVersion is required for operation=act");
				if (!params.action) throw new Error("action is required for operation=act");
				const result = await invokeVehicle<SessionActResult>(
					"session.act",
					{
						name: params.name,
						snapshotVersion: params.snapshotVersion,
						action: params.action,
						url: params.url,
						selector: params.selector,
						script: params.script,
						timeoutMs: params.timeoutMs,
						text: params.text,
						clear: params.clear,
						value: params.value,
						label: params.label,
						loadState: params.loadState,
						state: params.state,
						key: params.key,
						fullPage: params.fullPage,
						scale: params.scale,
						depth: params.depth,
						boxes: params.boxes,
						mode: params.mode,
						accept: params.accept,
						promptText: params.promptText,
						includeStatic: params.includeStatic,
						tabOperation: params.tabOperation,
						tabIndex: params.tabIndex,
					},
					callMeta,
				);

				if (params.action === "screenshot" && typeof result.screenshotBase64 === "string") {
					const summary = { name: result.name, action: result.action, snapshotVersion: result.snapshotVersion };
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(summary) },
							{ type: "image" as const, data: result.screenshotBase64, mimeType: "image/png" },
						],
						details: createSessionActDetails({ name: result.name, action: result.action, snapshotVersion: result.snapshotVersion }),
					};
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: createSessionActDetails({
						name: result.name,
						action: result.action,
						snapshotVersion: result.snapshotVersion,
						result: result.result,
					}),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_session failed: ${message}`);
			}
		},
	});

	// ---------------------------------------------------------------------------
	// web_category — curated, agent/user-assignable relevance categories for
	// cached pages. Distinct from `domain` (URL hostname) and `tags` (publisher-
	// provided, auto-extracted from a page's own HTML): a category is a judgment
	// about what a page is *for*, made by whoever's curating, growing organically
	// as new topics come up rather than a closed enum. A page can and often will
	// belong to more than one category at once -- overlap is the expected case.
	// Kept as its own tool rather than folded into web_fetch, matching this
	// project's own precedent (web_session exists separately for the same
	// reason): a genuinely new capability gets its own contract instead of
	// growing web_fetch's.
	// ---------------------------------------------------------------------------
	const categoryParamsSchema = Type.Object({
		operation: Type.Union([Type.Literal("assign"), Type.Literal("remove"), Type.Literal("rename"), Type.Literal("list")], {
			description: "assign/remove a category on a page, rename (or merge) one everywhere it's used, or list every category",
		}),
		url: Type.Optional(Type.String({ description: "assign/remove: the cached page's URL (must already be cached)" })),
		category: Type.Optional(Type.String({ description: "assign/remove: category name. rename: its current name." })),
		newName: Type.Optional(
			Type.String({ description: "rename: new name; merges into an existing category of that name instead of erroring" }),
		),
	});

	type CategoryParams = Static<typeof categoryParamsSchema>;

	interface CategoryPresentationDetails {
		version: typeof DETAILS_VERSION;
		kind: "web-category";
		operation: CategoryParams["operation"];
		summary: string;
		items: string[];
		total: number;
		truncated: boolean;
	}

	function createCategoryDetails(
		operation: CategoryParams["operation"],
		summary: string,
		rows: string[] = [],
	): CategoryPresentationDetails {
		const total = rows.length;
		const items = rows.slice(0, DETAILS_MAX_ITEMS);
		return { version: DETAILS_VERSION, kind: "web-category", operation, summary, items, total, truncated: total > items.length };
	}

	pi.registerTool({
		name: "web_category",
		label: "Web Category",
		description: [
			'Curated, agent/user-assignable relevance categories for cached pages -- e.g. "Code", "PTP Protocol". Distinct from a page\'s domain and its publisher-supplied tags: a category is your own judgment about what a page is *for*.',
			"Free-form -- invent a name the first time you need it. A page can belong to more than one category; overlap is expected. Use web_fetch(category=X) with no url to list pages in a category.",
		].join("\n"),
		promptSnippet:
			"Curated relevance categories for cached pages: assign/remove/rename/list, with overlap (a page can belong to more than one)",
		parameters: categoryParamsSchema,
		// category.* has migrated onto the real Vehicle protocol (see web-spider-daemon's
		// category-vehicle.ts) -- invokeWebSpiderVehicleOperation() runs each sub-action
		// through the same cross-cutting policy layer (activity broadcasting, the /safety
		// ask gate, the approval-required retry dance) a registerVehicleTools()-registered
		// tool gets automatically, while keeping this tool's own consolidated
		// operation=assign/remove/rename/list shape unchanged.
		async execute(toolCallId, params: CategoryParams, signal, _onUpdate, context) {
			try {
				async function invoke<T>(operationName: string, input: Record<string, unknown>): Promise<T> {
					const result = await invokeWebSpiderVehicleOperation(operationName, input, {
						toolName: "web_category",
						toolCallId,
						signal,
						context,
					});
					return result.details.output as T;
				}

				if (params.operation === "list") {
					const result = await invoke<{ categories: Array<{ id: number; name: string; pageCount: number }> }>("category.list", {});
					const rows = result.categories.map((c) => `${c.name}  (${c.pageCount} page(s))`);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createCategoryDetails(
							"list",
							`${result.categories.length} categor${result.categories.length === 1 ? "y" : "ies"}`,
							rows,
						),
					};
				}
				if (params.operation === "assign") {
					if (!params.url) throw new Error("url is required for operation=assign");
					if (!params.category) throw new Error("category is required for operation=assign");
					const result = await invoke<{ url: string; category: string; categoryId: number }>("category.assign", {
						url: params.url,
						category: params.category,
					});
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createCategoryDetails("assign", `"${result.category}" → ${result.url}`),
					};
				}
				if (params.operation === "remove") {
					if (!params.url) throw new Error("url is required for operation=remove");
					if (!params.category) throw new Error("category is required for operation=remove");
					const result = await invoke<{ url: string; category: string; removed: true }>("category.remove", {
						url: params.url,
						category: params.category,
					});
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createCategoryDetails("remove", `removed "${result.category}" from ${result.url}`),
					};
				}
				// rename
				if (!params.category) throw new Error("category is required for operation=rename");
				if (!params.newName) throw new Error("newName is required for operation=rename");
				const result = await invoke<{ categoryId: number; name: string; merged: boolean }>("category.rename", {
					category: params.category,
					newName: params.newName,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					details: createCategoryDetails("rename", result.merged ? `merged into "${result.name}"` : `renamed to "${result.name}"`),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_category failed: ${message}`);
			}
		},
	});

	// ---------------------------------------------------------------------------
	// web_quotes -- standalone resource finder. Given a query and an explicit
	// urls list (typically a prior web_fetch(searchQuery=...) call's own
	// results), fetches each one and returns ranked, verbatim BM25F quotes per
	// url -- never an LLM-digested answer (see the daemon's quotes-service.ts
	// doc comment and the "standalone quote/resource-finder extraction mode"
	// design task for the full rationale). Kept as its own tool rather than a
	// web_fetch mode, matching this project's own precedent (web_session,
	// web_category): a genuinely new capability gets its own contract.
	// ---------------------------------------------------------------------------
	const quotesParamsSchema = Type.Object({
		query: Type.String({ description: "Text to rank quotes against -- the same query you'd pass to web_fetch(searchQuery=...)" }),
		urls: Type.Array(Type.String(), {
			description: "URLs to fetch and extract quotes from -- typically a prior web_fetch(searchQuery=...) call's own result urls",
		}),
		maxQuotesPerUrl: Type.Optional(
			Type.Number({ description: "Per-url quote cap so one page can't dominate the combined result (default 3, max 20)" }),
		),
		maxQuotesTotal: Type.Optional(Type.Number({ description: "Combined quote cap across every url (default 15, max 100)" })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
		enhanced: Type.Optional(Type.Boolean({ description: "Force headless-browser rendering for SPAs/JS-heavy/bot-gated pages" })),
		ignoreRobots: Type.Optional(
			Type.Boolean({ description: "Explicit, audited bypass of robots.txt for this one request -- human-directed only" }),
		),
		sources: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Named per-site strategies to try before generic fetch+Readability, applied to every url -- see web_fetch's own sources parameter for the full list and rationale.",
			}),
		),
		maxCacheAgeMs: Type.Optional(
			Type.Number({
				description: "Reject an already-cached hit older than this many ms for every url -- see web_fetch's own maxCacheAgeMs.",
			}),
		),
	});

	type QuotesParams = Static<typeof quotesParamsSchema>;

	pi.registerTool({
		name: "web_quotes",
		label: "Web Quotes",
		description: [
			"A standalone resource finder -- fetches an explicit set of urls (e.g. a prior web_fetch(searchQuery=...) call's own results) and returns ranked, verbatim BM25F quotes per url as resource cards. Never an LLM-digested answer: every quote is the source's own exact text, never paraphrased or summarized. The intended two-call recipe is web_fetch(searchQuery=...) to find urls, then web_quotes(query, urls) to pull exact quotes from them.",
			"",
			"Every quote carries citationUrl, a real, standards-based URL Text Fragment (#:~:text=...) that scrolls to and highlights the exact quoted passage in any modern browser. Always cite each quote's citationUrl (falling back to its resource's url) verbatim when presenting it to the user -- never state a quote's content without its source link.",
			"",
			"maxQuotesPerUrl (default 3, max 20) caps each url's own share so one page can't dominate the combined result; maxQuotesTotal (default 15, max 100) bounds the whole response. A url that fails to fetch becomes { url, error } in its own resource card rather than failing the whole batch.",
			"",
			"sources=[...] applies named per-site strategies (llms-txt, markdown-suffix, github, mediawiki, youtube) to every url before generic fetch+Readability -- see web_fetch's own sources parameter.",
			"",
			"maxCacheAgeMs rejects an already-cached hit older than this many ms for every url -- see web_fetch's own maxCacheAgeMs.",
		].join("\n"),
		promptSnippet: "Resource finder: ranked, verbatim BM25F quotes per url, each with a citationUrl -- never an LLM-digested answer",
		parameters: quotesParamsSchema,
		renderCall(args, theme, context) {
			return renderWebQuotesCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebQuotesResult(result, options, theme, context);
		},
		async execute(toolCallId, params: QuotesParams, signal, _onUpdate, context) {
			try {
				if (!params.query?.trim()) throw new Error("query is required and must be non-empty");
				if (!params.urls || params.urls.length === 0) throw new Error("urls is required and must contain at least one url");
				const callMeta: CallMeta = { toolName: "web_quotes", toolCallId, signal, context };
				const result = await invokeVehicle<{
					query: string;
					urlsRequested: number;
					errors?: number;
					errorUrls?: string[];
					resources: Array<Record<string, unknown>>;
				}>(
					"quotes",
					{
						query: params.query,
						urls: params.urls,
						maxQuotesPerUrl: params.maxQuotesPerUrl,
						maxQuotesTotal: params.maxQuotesTotal,
						timeoutMs: params.timeoutMs,
						enhanced: params.enhanced,
						ignoreRobots: params.ignoreRobots,
						sources: params.sources,
						maxCacheAgeMs: params.maxCacheAgeMs,
					},
					callMeta,
				);
				return createQuotesResult(result, createQuotesDetails(result.query, result.resources));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_quotes failed: ${message}`);
			}
		},
	});

	registerWebSpiderUsageCommand(pi);
}

// ---------------------------------------------------------------------------
// Small local helper — omitEmpty was part of format.ts, which moved to the
// daemon package; kept here as the one remaining consumer (detail/content
// reshaping in this file only, not page formatting).
// ---------------------------------------------------------------------------
function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)),
	);
}
