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
import { callWebSpider, invokeWebSpiderVehicleOperation } from "./retrying-client.js";
import {
	createSessionActDetails,
	createSessionLifecycleDetails,
	createSessionListDetails,
	renderWebSessionCall,
	renderWebSessionResult,
} from "./session-presentation.js";

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

	// callWebSpider() auto-starts the daemon transparently on first use if it
	// isn't already running, and retries once against a freshly re-resolved
	// client if a cached connection turns out stale (the daemon restarted on
	// a new port since it was cached) -- see retrying-client.ts.
	async function call<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
		try {
			return await callWebSpider<T>(operation, input);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log("error", "daemon operation failed", { operation, error: message });
			throw error;
		}
	}

	/**
	 * Like call(), but for whichever operations have migrated onto the real
	 * Vehicle protocol (cache.list/cache.search today; see cache-vehicle.ts) --
	 * routes through invokeWebSpiderVehicleOperation() instead, so web_fetch's
	 * cache-view branches get the same cross-cutting policy (activity
	 * broadcasting, the /safety gate, approval retry) web_category already has.
	 */
	async function invokeVehicle<T = unknown>(
		operation: string,
		input: Record<string, unknown>,
		callMeta: { toolCallId: string; signal?: AbortSignal; context: ExtensionContext },
	): Promise<T> {
		try {
			const result = await invokeWebSpiderVehicleOperation(operation, input, { toolName: "web_fetch", ...callMeta });
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

	// ---------------------------------------------------------------------------
	// Papyrus ingestion — Web Spider is a context source, Papyrus is the context
	// mesh. Explicit opt-in only (params.ingest === true): never triggered by an
	// ordinary fetch/search, matching the daemon's own "papyrus.ingest" contract
	// (bounded batch, "web-spider:web"/"web-spider:web-search-result" subtypes, immutable service output).
	// Scoped to a single-page fetch and a search, not crawl or cache views — a
	// crawl can produce more pages than the ingest batch bound and picking which
	// ones matter is a separate design question left for a follow-up.
	// ---------------------------------------------------------------------------
	type PapyrusIngestOutcome = {
		ingested: Array<{ url: string; docId: string }>;
		skipped: Array<{ url: string; reason: string }>;
	};

	async function maybeIngestPage(params: Params, url: string): Promise<PapyrusIngestOutcome | undefined> {
		if (params.ingest !== true) return undefined;
		return await call<PapyrusIngestOutcome>("papyrus.ingest", { kind: "pages", urls: [url], relatesTo: params.relatesTo });
	}

	async function maybeIngestSearch(
		params: Params,
		query: string,
		results: Array<{ url: string; title: string; snippet: string; publishedAt?: string }>,
	): Promise<PapyrusIngestOutcome | undefined> {
		if (params.ingest !== true) return undefined;
		return await call<PapyrusIngestOutcome>("papyrus.ingest", { kind: "search", query, results, relatesTo: params.relatesTo });
	}

	function withPapyrus<T extends Record<string, unknown>>(content: T, papyrus: PapyrusIngestOutcome | undefined): T {
		return papyrus ? { ...content, papyrus } : content;
	}

	/** Splits the daemon's "cache" hit/miss field out of a fetch result — historically renderer-only, never model content. */
	function splitCache<T extends { cache?: "hit" | "miss" }>(result: T): { content: Omit<T, "cache">; cache: "hit" | "miss" | undefined } {
		const { cache, ...content } = result;
		return { content, cache };
	}

	// ---------------------------------------------------------------------------
	// Path handlers — each owns one execution branch. SRP: one reason to change.
	// ---------------------------------------------------------------------------

	async function handleSearch(params: Params) {
		const query = params.searchQuery ?? "";
		const result = await call<{ query: string; results: Array<{ url: string; title: string; snippet: string; publishedAt?: string }> }>(
			"search",
			{
				query,
				numResults: params.limit ?? 10,
				siteFilter: params.siteFilter,
				wantFullContent: params.wantFullContent,
			},
		);
		log("info", "web search done", { query, hits: result.results.length });
		const papyrus = await maybeIngestSearch(params, query, result.results);
		return output(
			withPapyrus(
				{
					query: result.query,
					results: result.results,
					hint: "Use the url field from a result to fetch its full content with web_fetch(url=...).",
				},
				papyrus,
			),
			createWebDetails({
				operation: "search",
				format: "search",
				status: result.results.length === 0 ? "empty" : "ok",
				query,
				hits: result.results.length,
				items: result.results.map((r) => ({ url: r.url, title: r.title })),
				papyrusDocs: papyrus?.ingested.length,
			}),
		);
	}

	async function handleCacheListing(params: Params, callMeta: { toolCallId: string; signal?: AbortSignal; context: ExtensionContext }) {
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

	async function handleCacheSearch(params: Params, callMeta: { toolCallId: string; signal?: AbortSignal; context: ExtensionContext }) {
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

	async function handleCrawl(params: Params) {
		const fmt = params.format ?? "markdown";
		const depth = params.depth ?? 0;
		const url = params.url ?? "";

		const result = await call<Record<string, unknown>>("crawl", {
			url,
			format: fmt,
			depth,
			maxPages: params.maxPages ?? 10,
			sameDomain: params.sameDomain,
			rootSelector: params.rootSelector,
			excludeSelectors: params.excludeSelectors,
			tokenBudget: params.tokenBudget,
			enhanced: params.enhanced,
			timeoutMs: params.timeoutMs,
			query: params.query,
			ignoreRobots: params.ignoreRobots,
		});
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

	async function handleTreeFormat(params: Params) {
		const url = params.url ?? "";
		try {
			if (params.path) {
				const node = await call<{ found?: false; path?: string; tag?: string } & Record<string, unknown>>("fetch", {
					url,
					format: "tree",
					path: params.path,
					rootSelector: params.rootSelector,
					excludeSelectors: params.excludeSelectors,
					enhanced: params.enhanced,
					ignoreRobots: params.ignoreRobots,
				});
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
				const result = await call<{
					url: string;
					query: string;
					hits: Array<{ path: string; tag: string; score: number; snippet: string }>;
				}>("fetch", {
					url,
					format: "tree",
					query: params.query,
					topN: params.topN,
					rootSelector: params.rootSelector,
					excludeSelectors: params.excludeSelectors,
					enhanced: params.enhanced,
					ignoreRobots: params.ignoreRobots,
				});
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

			const tree = await call<Record<string, unknown>>("fetch", {
				url,
				format: "tree",
				rootSelector: params.rootSelector,
				excludeSelectors: params.excludeSelectors,
				enhanced: params.enhanced,
				ignoreRobots: params.ignoreRobots,
			});
			return output(tree, createWebDetails({ operation: "tree-full", format: "tree", url }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`tree fetch failed: ${message}`);
		}
	}

	async function handleSinglePage(params: Params) {
		const fmt = params.format ?? "markdown";
		const url = params.url ?? "";

		if (fmt === "tree") return handleTreeFormat(params);

		const raw = await call<Record<string, unknown> & { cache?: "hit" | "miss"; blocked?: boolean }>("fetch", {
			url,
			format: fmt,
			rootSelector: params.rootSelector,
			excludeSelectors: params.excludeSelectors,
			tokenBudget: params.tokenBudget,
			enhanced: params.enhanced,
			timeoutMs: params.timeoutMs,
			query: params.query,
			ignoreRobots: params.ignoreRobots,
		});

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
		const papyrus = await maybeIngestPage(params, url);

		if (fmt === "lean") {
			return output(
				withPapyrus(content, papyrus),
				createWebDetails({
					operation: "fetch",
					format: "lean",
					url,
					title: String(content.title ?? ""),
					wordCount: Number(content.wordCount ?? 0),
					cache,
					enhanced: params.enhanced,
					papyrusDocs: papyrus?.ingested.length,
				}),
			);
		}

		if (fmt === "links") {
			const links = (content.bodyLinks as unknown[] | undefined) ?? [];
			return output(
				withPapyrus(content, papyrus),
				createWebDetails({
					operation: "fetch",
					format: "links",
					url,
					title: String(content.title ?? ""),
					links: links.length,
					cache,
					enhanced: params.enhanced,
					items: links.map((link) => ({ url: (link as { href: string }).href, title: (link as { text: string }).text })),
					papyrusDocs: papyrus?.ingested.length,
				}),
			);
		}

		if (fmt === "highlights") {
			const hits = (content.hits as unknown[] | undefined) ?? [];
			const withHint = hits.length === 0 ? { ...content, hint: "No matches. Try broader terms or use format=markdown." } : content;
			return output(
				withPapyrus(withHint, papyrus),
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
					papyrusDocs: papyrus?.ingested.length,
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
			withPapyrus(withHint, papyrus),
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
				papyrusDocs: papyrus?.ingested.length,
			}),
		);
	}

	// ---------------------------------------------------------------------------
	// Tool registration
	// ---------------------------------------------------------------------------

	// Defined here so Params = Static<typeof paramsSchema> resolves concretely
	// rather than being derived through registerTool's unresolved generic.
	const paramsSchema = Type.Object({
		url: Type.Optional(Type.String({ description: "Fully-qualified http(s) URL to fetch or crawl from" })),

		depth: Type.Optional(
			Type.Number({
				description: "BFS depth. 0=single page (default). 1=page + all its links. N=N hops deep.",
			}),
		),
		maxPages: Type.Optional(
			Type.Number({
				description: "Hard cap on total pages when depth>0 (default 10).",
			}),
		),
		sameDomain: Type.Optional(
			Type.Boolean({
				description: "Only follow links on the same domain when depth>0 (default true).",
			}),
		),

		enhanced: Type.Optional(
			Type.Boolean({
				description:
					"When true, always uses a headless browser (playwright-core + system Chrome, stealth mode). " +
					"When false (default), direct fetch is used and Playwright kicks in automatically " +
					"only if the page is detected as JS-rendered.",
			}),
		),

		format: Type.Optional(
			Type.Union(
				[Type.Literal("markdown"), Type.Literal("lean"), Type.Literal("links"), Type.Literal("highlights"), Type.Literal("tree")],
				{
					description: "markdown=full body (default), lean=outline only, links=link list, highlights=BM25F chunks, tree=semantic DOM tree.",
				},
			),
		),
		query: Type.Optional(
			Type.String({
				description: "Search phrase. Required for format=highlights. Optional for format=tree (searches the tree).",
			}),
		),
		path: Type.Optional(
			Type.String({
				description: "Dot-bracket path for format=tree navigation, e.g. article.section[1].pre[0].code",
			}),
		),
		topN: Type.Optional(
			Type.Number({
				description: "Max hits to return for format=tree with query (default 5).",
			}),
		),

		grep: Type.Optional(
			Type.String({
				description:
					"Filter cached pages by substring match on url, title, domain, or description. Only applies when url is omitted (local cache listing).",
			}),
		),
		domain: Type.Optional(
			Type.String({ description: 'Cache listing only: exact, case-insensitive match on the page\'s domain (e.g. "github.com").' }),
		),
		tag: Type.Optional(
			Type.String({
				description:
					"Cache listing only: filter to pages whose auto-extracted tags include this one. A page with multiple tags matches every one of its own tags' queries.",
			}),
		),
		category: Type.Optional(
			Type.String({
				description:
					"Cache listing only: filter to pages assigned this curated relevance category (see web_category). A page in multiple categories matches every one of its own categories' queries.",
			}),
		),
		fetchedAfter: Type.Optional(
			Type.Number({ description: "Cache listing only: epoch ms lower bound on when the page was cached (not when it was published)." }),
		),
		fetchedBefore: Type.Optional(
			Type.Number({ description: "Cache listing only: epoch ms upper bound on when the page was cached (not when it was published)." }),
		),
		publishedAfter: Type.Optional(
			Type.String({ description: "Cache listing only: ISO-8601 lower bound on the page's own published date (not when it was cached)." }),
		),
		publishedBefore: Type.Optional(
			Type.String({ description: "Cache listing only: ISO-8601 upper bound on the page's own published date (not when it was cached)." }),
		),
		sortBy: Type.Optional(
			Type.Union([Type.Literal("fetchedAt"), Type.Literal("publishedAt"), Type.Literal("url"), Type.Literal("domain")], {
				description: "Cache listing only: sort field. Defaults to fetchedAt (most recently cached first).",
			}),
		),
		sortOrder: Type.Optional(
			Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Cache listing only: sort direction. Defaults to desc." }),
		),
		offset: Type.Optional(
			Type.Number({
				description: "Skip first N results when listing or searching the local cache (pagination).",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Max results to return from cache listing or search (default 20, hard cap 100 for listing, 10 for search).",
			}),
		),

		rootSelector: Type.Optional(
			Type.String({
				description: 'CSS selector to scope extraction (e.g. "article"). Discards everything outside.',
			}),
		),
		excludeSelectors: Type.Optional(
			Type.String({
				description: 'Comma-separated CSS selectors to remove before extraction (e.g. "nav, footer, .sidebar").',
			}),
		),
		tokenBudget: Type.Optional(
			Type.Number({
				description:
					"Approximate max tokens to return (~4 chars/token), capped at 10,000. Truncation carries explicit completeness markers.",
			}),
		),
		searchQuery: Type.Optional(
			Type.String({
				description:
					"Web search query. Pass instead of url when you don't know the exact URL. " +
					"Returns ranked results (url, title, snippet) from Brave/Tavily/Exa/Serper/SerpApi/You.com. " +
					"Use the returned URLs to fetch the actual page content.",
			}),
		),
		siteFilter: Type.Optional(
			Type.String({
				description:
					'Restrict searchQuery results to one domain (e.g. "reddit.com"). Routed by which ' +
					"configured provider has actually returned matching results for that domain before -- " +
					"some domains (e.g. reddit.com, which blocks most search engines' crawlers) return " +
					"real coverage from only a subset of providers regardless of which one answers first.",
			}),
		),
		wantFullContent: Type.Optional(
			Type.Boolean({
				description:
					'Declares intent -- "give me full page content" alongside each searchQuery result -- ' +
					"without naming a provider. Routed to whichever configured provider can actually supply it " +
					"(Tavily, Exa); providers that can't ignore it, same as an unsupported filter.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Per-request fetch timeout in milliseconds (default 30 000). " +
					"Increase for slow sites; decrease to fail fast in latency-sensitive loops.",
			}),
		),

		ingest: Type.Optional(
			Type.Boolean({
				description:
					"When true, push the result into Papyrus (the context mesh) as a Doc artifact after a " +
					"successful single-page fetch (url, depth=0) or a searchQuery search. Explicit opt-in only " +
					"\u2014 never triggered by an ordinary fetch. Ignored for depth>0 crawls and local cache views " +
					"(no url/searchQuery). Response includes a papyrus field with the created Doc id(s).",
			}),
		),
		relatesTo: Type.Optional(
			Type.String({
				description: "Existing Papyrus artifact id to link the ingested Doc(s) to via 'references'. Only used with ingest=true.",
			}),
		),
		ignoreRobots: Type.Optional(
			Type.Boolean({
				description:
					"Explicit, audited opt-out of the robots.txt check for this one request. Never use by default — " +
					"only when a site's blanket disallow is a bandwidth/scraping-abuse guard rather than genuinely " +
					"private content, and you (a human) have directed this specific fetch. Every use is logged.",
			}),
		),
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: [
			"Fetch a URL and return its content. Optionally crawl to a given depth.",
			"Can also search the web when searchQuery is provided instead of a URL.",
			"",
			"SEARCH FIRST — avoid hallucinated URLs",
			"  If you are not certain the URL exists, pass searchQuery instead of url.",
			"  The tool will run a web search and return ranked results with real URLs.",
			"  Then fetch the result URL you want. Never guess article slugs or paths.",
			"  Example wrong: web_fetch(url='martinfowler.com/articles/agent-as-platform.html')",
			"  Example right: web_fetch(searchQuery='Martin Fowler agent as platform')",
			"",
			"LOCAL MATERIALIZED VIEW (no url)",
			"  Omit url to query the local page cache (disk-backed, survives restarts).",
			"  No url, no query  — list all cached pages in lean format.",
			"  No url, query=X  — BM25F full-text search across all cached pages.",
			"  grep=X           — filter list by url/title/domain/description substring.",
			"  domain=X         — exact match on the page's domain.",
			"  tag=X            — pages whose auto-extracted tags include X (a page can match more than one tag's query).",
			"  category=X       — pages assigned this curated relevance category (see web_category). A page can match more than one category's query.",
			"  fetchedAfter/fetchedBefore     — epoch ms range on when a page was cached.",
			"  publishedAfter/publishedBefore — ISO-8601 range on the page's own published date.",
			"  sortBy=fetchedAt|publishedAt|url|domain, sortOrder=asc|desc — defaults to fetchedAt/desc.",
			"  offset/limit     — paginate results (default limit 20, hard cap 100).",
			"",
			"DEPTH",
			"  depth=0 (default) — fetch the single URL.",
			"  depth=1           — fetch the URL and every page it links to (same domain).",
			"  depth=N           — BFS crawl N hops deep, up to maxPages total.",
			"  When depth>0, returns a crawl summary and caches all pages.",
			"  Subsequent calls with depth=0 to any cached URL are free (no network).",
			"",
			"FORMAT",
			"  markdown   — clean markdown body + metadata. Default.",
			"  lean       — metadata + headings + links, no body text. ~10-20x fewer tokens.",
			"               Best for deciding whether to read a page, or crawl triage.",
			"  links      — outbound links only (href + anchor text + rel).",
			"  highlights — BM25F search the page and return matching text blocks.",
			"               Requires `query`. Returns up to 5 scored chunks with context.",
			"               Use instead of reading full markdown when you know what to find.",
			"               Works across all cached pages when depth>0.",
			"  tree       — collapsed semantic DOM tree (div/span stripped, only meaningful tags).",
			"               Add query= to search the tree (atomic hits: whole code blocks, whole tables).",
			"               Add path= to navigate to one node (e.g. article.section[1].pre[0].code).",
			"               Tree is cached — tree then tree+query then tree+path costs one network request.",
			"",
			"SCOPING",
			'  rootSelector    — CSS selector to scope to (e.g. "article"). Ignores everything else.',
			'  excludeSelectors — comma-separated selectors to strip (e.g. "nav, footer, .ads").',
			"  tokenBudget     — max ~tokens returned (~4 chars/token). Truncates at line boundary.",
			"",
			"ENHANCED MODE (JS rendering)",
			"  enhanced=true  — use a headless browser with stealth (playwright-core + system Chrome).",
			"                   Use for SPAs, JS-heavy pages, or sites with basic bot detection.",
			"  enhanced=false — use direct fetch (default). Playwright auto-fallback kicks in",
			"                   when the page is detected as JS-rendered.",
			"",
			"THROTTLING",
			"  Requests are automatically rate-limited per domain (500ms min delay).",
			"  On 429/503, backs off exponentially and respects Retry-After headers.",
			"  robots.txt is checked and respected before each fetch (depth=0 and depth>0).",
			"  ignoreRobots=true  — explicit, audited bypass for this one request. Never default;",
			"                       use only for a human-directed one-off fetch, not bulk crawling.",
			"",
			"CONTEXT MESH",
			"  ingest=true    — push this fetch's page or this search's results into Papyrus as Doc",
			"                   artifact(s). Explicit only, never automatic. Works with a single-page",
			"                   fetch (depth=0) or searchQuery; ignored for crawls and cache views.",
			"  relatesTo=ID   — link the ingested Doc(s) to an existing Papyrus artifact via 'references'.",
			"  Response gains a papyrus field: {ingested: [{url, docId}], skipped: [{url, reason}]}.",
		].join("\n"),
		promptSnippet: "Fetch URL: format=markdown/lean/links/highlights, depth, rootSelector, tokenBudget",
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
				if (params.searchQuery?.trim()) return await handleSearch(params);

				if (!params.url) {
					const callMeta = { toolCallId, signal, context };
					if (params.query?.trim()) return await handleCacheSearch(params, callMeta);
					return await handleCacheListing(params, callMeta);
				}

				if ((params.depth ?? 0) > 0) return await handleCrawl(params);

				return await handleSinglePage(params);
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
			description: "create/list/close a named persistent browser session, or act on one.",
		}),
		name: Type.Optional(Type.String({ description: "Session name. Required for create/close/act." })),
		forceChromeChannel: Type.Optional(
			Type.Boolean({
				description:
					"create only: force the full installed Chrome channel instead of Playwright's own default headless shell (default false).",
			}),
		),
		snapshotVersion: Type.Optional(
			Type.Number({
				description:
					"act only, required. The session's snapshot version this action expects — read it off the previous " +
					"response (create returns 0; every act() response returns the current value). Acting with a stale " +
					"value fails closed rather than silently acting against a page that may have navigated underneath you.",
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
						"act only, required. navigate/click/hover/pressKey/type/select act on the page (bump/consult " +
						"snapshotVersion per above). waitFor blocks until a condition is true — use this instead of guessing " +
						"a delay. queryText/readTable return structured data — use these instead of eval + hand-parsing text. " +
						"snapshot returns a YAML accessibility tree — prefer this over screenshot for understanding page " +
						"structure, it's cheaper and more precise. handleDialog arms accept/dismiss for the next native " +
						"dialog. downloads/consoleMessages/networkRequests read already-captured session activity. tabs " +
						"manages multiple tabs (list/new/close/select). eval runs arbitrary JavaScript and returns its " +
						"JSON-serializable result — prefer the more structured actions above when they fit. screenshot " +
						"returns a PNG.",
				},
			),
		),
		url: Type.Optional(Type.String({ description: "navigate: the URL to load. tabs (tabOperation=new): optional URL for the new tab." })),
		selector: Type.Optional(
			Type.String({
				description:
					"click/hover/type/select/waitFor/queryText/readTable/snapshot(scope)/screenshot(element-scoped): a CSS selector. pressKey: optional, focuses the element first.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description:
					"type: the text to type (real per-key keyboard input, not a directly-set value — works with pages that " +
					"have their own JS-bound keyboard handling). waitFor: text to wait for (Playwright's own text locator).",
			}),
		),
		clear: Type.Optional(Type.Boolean({ description: "type only: clear existing content first (default true). Set false to append." })),
		value: Type.Optional(Type.String({ description: "select: match an option by its value attribute. Exactly one of value/label." })),
		label: Type.Optional(Type.String({ description: "select: match an option by its visible label. Exactly one of value/label." })),
		loadState: Type.Optional(
			Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")], {
				description: "waitFor: wait for a page navigation state instead of a selector/text condition.",
			}),
		),
		state: Type.Optional(
			Type.Union([Type.Literal("visible"), Type.Literal("hidden"), Type.Literal("attached"), Type.Literal("detached")], {
				description: "waitFor: element state to wait for alongside selector/text (default visible). Not valid alongside loadState.",
			}),
		),
		script: Type.Optional(Type.String({ description: "eval: JavaScript to evaluate in the page; returns its JSON-serializable result." })),
		timeoutMs: Type.Optional(
			Type.Number({
				description: "Per-action timeout in milliseconds. Playwright's own default (bounded, never unbounded) applies when omitted.",
			}),
		),
		key: Type.Optional(
			Type.String({ description: 'pressKey: the key to press, e.g. "Enter", "Escape", "Tab", "ArrowLeft". Required for pressKey.' }),
		),
		fullPage: Type.Optional(
			Type.Boolean({
				description:
					"screenshot: capture the whole scrollable page instead of just the viewport (default false). Not valid alongside selector.",
			}),
		),
		scale: Type.Optional(
			Type.Union([Type.Literal("css"), Type.Literal("device")], {
				description: "screenshot: image resolution — css pixels (default) or real device pixel ratio.",
			}),
		),
		depth: Type.Optional(Type.Number({ description: "snapshot: limit the accessibility tree's depth." })),
		boxes: Type.Optional(
			Type.Boolean({
				description:
					"snapshot: include each node's bounding box ([box=x,y,width,height], viewport-relative CSS pixels) — ties structure to real pixel coordinates without needing vision.",
			}),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("ai"), Type.Literal("default")], {
				description:
					'snapshot: "ai" mode adds element references, doesn\'t wait for a matching element (throws if missing), and includes <iframe> content. Default "default".',
			}),
		),
		accept: Type.Optional(
			Type.Boolean({
				description:
					"handleDialog: accept (true) or dismiss (false) the next native dialog. Required for handleDialog. Without arming this, dialogs auto-dismiss.",
			}),
		),
		promptText: Type.Optional(
			Type.String({ description: "handleDialog: text to answer a prompt() dialog with. Ignored for other dialog types." }),
		),
		includeStatic: Type.Optional(
			Type.Boolean({
				description: "networkRequests: include successful static resources (image/stylesheet/font/script) in the result. Default false.",
			}),
		),
		tabOperation: Type.Optional(
			Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("close"), Type.Literal("select")], {
				description:
					"tabs: required. list every open tab; new opens one (optionally navigating via url); close closes one (defaults to the active tab); select switches the active tab (tabIndex required).",
			}),
		),
		tabIndex: Type.Optional(
			Type.Number({
				description: "tabs: 0-based tab index. Required for tabOperation=select; optional for close (defaults to the active tab).",
			}),
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
			"Persistent, named browser sessions for pages that need real interaction — typing into search boxes,",
			"selecting dropdowns, waiting on async results, reading a results table — rather than a single fetch.",
			"tmux-session semantics: create once, act on the same page repeatedly, close when done.",
			"",
			"LIFECYCLE",
			"  operation=create  — launches an isolated, single-use Playwright browser process for this name.",
			"  operation=act     — dispatches one action against the session's one persistent page.",
			"  operation=list    — lists live sessions.",
			"  operation=close   — tears the session's browser down. Always close sessions you no longer need.",
			"",
			"SNAPSHOT VERSION (act only, required)",
			"  Every act() response includes snapshotVersion — pass it back on your next call for that session.",
			"  A stale value is rejected (the page may have navigated or changed since you last observed it) rather",
			"  than silently acting on out-of-date state. create returns snapshotVersion:0 to start with.",
			"",
			"ACTIONS (act only)",
			"  navigate  — load a URL.",
			"  click     — click selector.",
			"  hover     — hover selector — the only way to trigger CSS :hover-revealed menus/tooltips.",
			"  pressKey  — press a key (Enter/Escape/Tab/arrows). With selector, focuses it first; without one, a",
			"              global keyboard press for keys like Escape with no natural target element.",
			"  type      — type text into selector (real per-key input; clear=false to append instead of replace).",
			"  select    — choose a <select> option by value or label.",
			"  waitFor   — block until selector/text appears, or a load state is reached. Use this instead of",
			"              guessing a delay — a page's own async round-trip time is never something to assume.",
			"  queryText — trimmed text per element matching selector — structured data, not innerText + parsing.",
			"  readTable — rows/cells of a <table> matching selector — structured data, not innerText + parsing.",
			"  snapshot  — YAML accessibility tree (roles, names, ARIA attributes, hierarchy). PREFER THIS over",
			"              screenshot for understanding page structure — cheaper, more precise, and directly",
			"              describes what's interactable. boxes=true ties structure to real pixel coordinates.",
			"  handleDialog — arms accept/dismiss (+ optional promptText) for the NEXT native dialog, before the",
			"              action expected to trigger it. Without this, dialogs auto-dismiss (no hang risk either way).",
			"  downloads — lists files downloaded so far (already saved to disk). Call after the triggering click.",
			"  consoleMessages / networkRequests — read already-captured console output / network activity, useful",
			"              for debugging why something isn't working.",
			"  tabs      — tabOperation=list|new|close|select manages multiple tabs within the session.",
			"  eval      — arbitrary JavaScript, returns its JSON-serializable result. Prefer the actions above when",
			"              they fit — eval is the least structured, least auditable option.",
			"  screenshot — returns a PNG. Defaults to viewport-only; fullPage=true for the whole scrollable page,",
			"              or selector for one element's own bounding box.",
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
		async execute(_id, params: SessionParams, _signal, _onUpdate, _ctx) {
			try {
				if (params.operation === "create") {
					if (!params.name) throw new Error("name is required for operation=create");
					const result = await call<{ name: string; snapshotVersion: number; closed: boolean }>("session.create", {
						name: params.name,
						forceChromeChannel: params.forceChromeChannel,
					});
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionLifecycleDetails("create", result.name, { snapshotVersion: result.snapshotVersion }),
					};
				}
				if (params.operation === "list") {
					const result = await call<{ sessions: Array<{ name: string; closed: boolean }> }>("session.list", {});
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionListDetails(result.sessions),
					};
				}
				if (params.operation === "close") {
					if (!params.name) throw new Error("name is required for operation=close");
					const result = await call<{ name: string; closed: true }>("session.close", { name: params.name });
					return {
						content: [{ type: "text" as const, text: JSON.stringify(result) }],
						details: createSessionLifecycleDetails("close", result.name, { closed: true }),
					};
				}

				// act
				if (!params.name) throw new Error("name is required for operation=act");
				if (params.snapshotVersion === undefined) throw new Error("snapshotVersion is required for operation=act");
				if (!params.action) throw new Error("action is required for operation=act");
				const result = await call<SessionActResult>("session.act", {
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
				});

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
			description:
				"assign/remove a category on a cached page, rename (or merge, if the new name already exists) a category everywhere it's used, or list every known category.",
		}),
		url: Type.Optional(Type.String({ description: "assign/remove: the cached page's URL. Must already be cached -- fetch it first." })),
		category: Type.Optional(
			Type.String({ description: "assign/remove: the category name. rename: the existing category's current name." }),
		),
		newName: Type.Optional(
			Type.String({
				description:
					"rename only: the category's new name. If a category with this name already exists, the two merge (every page in either ends up in the surviving one) rather than erroring.",
			}),
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
			'Curated, agent/user-assignable relevance categories for cached pages -- e.g. "Code", "PTP Protocol".',
			"Distinct from a page's domain (its URL hostname) and tags (auto-extracted from the page's own HTML by its",
			"publisher) -- a category is your own judgment about what a page is *for*. Free-form: invent a new category",
			"name the first time you need it, there is no fixed list. A page can and often will belong to more than one",
			'category at once (a Rust PTP implementation is both "Code" and "PTP Protocol") -- that overlap is expected,',
			"not something to avoid. Use web_fetch(category=X) with no url to list every page currently in a category.",
			"",
			"  operation=assign  url=<url> category=<name>  — add the category to the page (creating it if new; assigning",
			"                    a category the page already has is a harmless no-op).",
			"  operation=remove  url=<url> category=<name>   — remove the category from the page (harmless no-op if it",
			"                    wasn't assigned).",
			"  operation=rename  category=<name> newName=<name> — rename a category everywhere it's used in one step. If",
			"                    newName already exists as a different category, the two merge instead of erroring.",
			"  operation=list                                — list every known category with how many pages use it --",
			"                    check this before inventing a near-duplicate name.",
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
