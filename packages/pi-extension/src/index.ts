/**
 * @danypops/pi-web-spider — Pi extension exposing web_fetch.
 *
 * Thin authenticated client of the Web Spider daemon (@danypops/web-spider-daemon):
 * this file owns the tool contract (parameters, output shapes, presentation)
 * and daemon connection lifecycle; it no longer performs any fetching,
 * crawling, caching, throttling, robots.txt checking, or Playwright
 * rendering itself — the daemon does all of that. See design doc
 * web-spider-daemon-architecture-and-papyrus-integration-contr-5s14.
 *
 * The daemon's operations return tool-agnostic data (see e.g.
 * fetch-service.ts/crawl-service.ts's own doc comments); this file
 * reconstructs the exact historical web_fetch JSON content — hint/status
 * text, cache-list compaction, the "cache" field split into the renderer
 * details channel — so the tool's observable behavior is unchanged.
 *
 * Install: pi install git:github.com/DanyPops/web-spider
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Static } from "typebox"
import { connectOrStartWebSpiderClient, type WebSpiderClient } from "./daemon-client.js"
import {
  createWebDetails,
  createWebResult,
  renderWebFetchCall,
  renderWebFetchResult,
  type WebPresentationDetails,
} from "./presentation.js"

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Diagnostics go only to a file — never to stdout/stderr, which belong to Pi's TUI.
  const diagPath = process.env.WEB_SPIDER_DIAG_PATH ?? join(homedir(), ".cache", "web-spider", "diag.log")
  const diag = (entry: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    try {
      mkdirSync(dirname(diagPath), { recursive: true })
      appendFileSync(diagPath, `${line}\n`)
    } catch { /* best-effort */ }
  }
  const log = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => {
    diag({ level, msg, ...extra !== undefined ? { extra } : {} })
  }

  // One shared connection attempt per session — connectOrStartWebSpiderClient()
  // auto-starts the daemon transparently on first use if it isn't already
  // running, so the tool "just works" without a manual `service install` step.
  let clientPromise: Promise<WebSpiderClient> | null = null
  const getClient = (): Promise<WebSpiderClient> => {
    if (!clientPromise) {
      clientPromise = connectOrStartWebSpiderClient().catch((error: unknown) => {
        clientPromise = null // allow a retry on the next call rather than caching a permanent failure
        const message = error instanceof Error ? error.message : String(error)
        log("error", "daemon connection failed", { error: message })
        throw error
      })
    }
    return clientPromise
  }

  type Params = Static<typeof paramsSchema>

  async function call<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
    const client = await getClient()
    try {
      return await client.call<T>(operation, input)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log("error", "daemon operation failed", { operation, error: message })
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // Local materialized view helpers
  // ---------------------------------------------------------------------------

  function pageItems(pages: Array<{ url: string; title?: string }>) {
    return pages.map((page) => ({ url: page.url, title: page.title ?? "" }))
  }

  function output(payload: unknown, details: WebPresentationDetails) {
    return createWebResult(payload, details)
  }

  // ---------------------------------------------------------------------------
  // Papyrus ingestion — Web Spider is a context source, Papyrus is the context
  // mesh. Explicit opt-in only (params.ingest === true): never triggered by an
  // ordinary fetch/search, matching the daemon's own "papyrus.ingest" contract
  // (bounded batch, "web"/"web-search-result" subtypes, immutable service output).
  // Scoped to a single-page fetch and a search, not crawl or cache views — a
  // crawl can produce more pages than the ingest batch bound and picking which
  // ones matter is a separate design question left for a follow-up.
  // ---------------------------------------------------------------------------
  type PapyrusIngestOutcome = {
    ingested: Array<{ url: string; docId: string }>
    skipped: Array<{ url: string; reason: string }>
  }

  async function maybeIngestPage(params: Params, url: string): Promise<PapyrusIngestOutcome | undefined> {
    if (params.ingest !== true) return undefined
    return await call<PapyrusIngestOutcome>("papyrus.ingest", { kind: "pages", urls: [url], relatesTo: params.relatesTo })
  }

  async function maybeIngestSearch(
    params: Params,
    query: string,
    results: Array<{ url: string; title: string; snippet: string; publishedAt?: string }>,
  ): Promise<PapyrusIngestOutcome | undefined> {
    if (params.ingest !== true) return undefined
    return await call<PapyrusIngestOutcome>("papyrus.ingest", { kind: "search", query, results, relatesTo: params.relatesTo })
  }

  function withPapyrus<T extends Record<string, unknown>>(content: T, papyrus: PapyrusIngestOutcome | undefined): T {
    return papyrus ? { ...content, papyrus } : content
  }

  /** Splits the daemon's "cache" hit/miss field out of a fetch result — historically renderer-only, never model content. */
  function splitCache<T extends { cache?: "hit" | "miss" }>(result: T): { content: Omit<T, "cache">; cache: "hit" | "miss" | undefined } {
    const { cache, ...content } = result
    return { content, cache }
  }

  // ---------------------------------------------------------------------------
  // Path handlers — each owns one execution branch. SRP: one reason to change.
  // ---------------------------------------------------------------------------

  async function handleSearch(params: Params) {
    const query = params.searchQuery ?? ""
    const result = await call<{ query: string; results: Array<{ url: string; title: string; snippet: string; publishedAt?: string }> }>("search", {
      query,
      numResults: params.limit ?? 10,
    })
    log("info", "web search done", { query, hits: result.results.length })
    const papyrus = await maybeIngestSearch(params, query, result.results)
    return output(withPapyrus({
      query: result.query,
      results: result.results,
      hint: "Use the url field from a result to fetch its full content with web_fetch(url=...).",
    }, papyrus), createWebDetails({
      operation: "search",
      format: "search",
      status: result.results.length === 0 ? "empty" : "ok",
      query,
      hits: result.results.length,
      items: result.results.map((r) => ({ url: r.url, title: r.title })),
      papyrusDocs: papyrus?.ingested.length,
    }))
  }

  async function handleCacheListing(params: Params) {
    const result = await call<{ total: number; filtered: number; offset: number; limit: number; pages: Array<Record<string, unknown>> }>("cache.list", {
      grep: params.grep,
      offset: params.offset,
      limit: params.limit,
    })
    const remaining = result.filtered - result.offset - result.pages.length
    const meta = omitEmpty({
      total: result.total,
      filtered: result.filtered !== result.total ? result.filtered : undefined,
      offset: result.offset || undefined,
      limit: result.limit,
      remaining: remaining > 0 ? remaining : undefined,
    })
    const items = pageItems(result.pages as Array<{ url: string; title?: string }>)
    return output({ ...meta, pages: result.pages }, createWebDetails({
      operation: "cache-list",
      format: "lean",
      status: result.pages.length === 0 ? "empty" : "ok",
      pages: result.filtered,
      cache: "listing",
      items,
      truncated: remaining > 0,
      complete: remaining <= 0,
    }))
  }

  async function handleCacheSearch(params: Params) {
    const result = await call<{ query: string; pagesSearched: number; hits: Array<{ url: string; title: string; score: number; heading: string; text: string }> }>("cache.search", {
      query: params.query ?? "",
      limit: params.limit ?? 10,
    })

    if (result.pagesSearched === 0) {
      return output({
        status: "empty",
        hint: "Local cache is empty. Fetch some pages first with depth=0 or depth>0.",
      }, createWebDetails({
        operation: "cache-search",
        format: "highlights",
        status: "empty",
        query: params.query,
        pages: 0,
        hits: 0,
        cache: "search",
      }))
    }

    // Historical content shape never included title on a hit — it stays daemon-side
    // (useful operational metadata for other consumers) but is stripped here.
    const hits = result.hits.map(({ url, heading, score, text }) => ({ url, heading, score, text }))
    return output({
      ...omitEmpty({ query: result.query, pagesSearched: result.pagesSearched }),
      hits,
      ...(hits.length === 0 ? { hint: "No matches. Try broader terms, or list cached pages with web_fetch(format=lean) and no url." } : {}),
    }, createWebDetails({
      operation: "cache-search",
      format: "highlights",
      status: hits.length === 0 ? "empty" : "ok",
      query: params.query,
      pages: result.pagesSearched,
      hits: hits.length,
      cache: "search",
      items: result.hits.map((h) => ({ url: h.url, title: h.title })),
    }))
  }

  async function handleCrawl(params: Params) {
    const fmt = params.format ?? "markdown"
    const depth = params.depth ?? 0
    const url = params.url ?? ""

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
    })
    const errors = typeof result.errors === "number" ? result.errors : 0

    if (fmt === "highlights") {
      const hits = (result.hits as unknown[] | undefined) ?? []
      return output(result, createWebDetails({
        operation: "crawl",
        format: "highlights",
        url,
        query: params.query,
        depth,
        pages: typeof result.pagesSearched === "number" ? result.pagesSearched : 0,
        hits: hits.length,
        errors,
        items: pageItems(hits as Array<{ url: string; title?: string }>),
      }))
    }

    const pages = (result.pages as Array<Record<string, unknown>> | undefined) ?? []
    const content = fmt === "lean"
      ? result
      : {
          ...result,
          // Historical guidance names the web_fetch tool specifically — added here,
          // not by the daemon, which also serves the tool-agnostic CLI.
          note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
        }

    return output(content, createWebDetails({
      operation: "crawl",
      format: fmt === "lean" ? "lean" : "markdown",
      url,
      depth,
      pages: typeof result.pagesFound === "number" ? result.pagesFound : pages.length,
      errors,
      items: pageItems(pages as Array<{ url: string; title?: string }>),
    }))
  }

  async function handleTreeFormat(params: Params) {
    const url = params.url ?? ""
    try {
      if (params.path) {
        const node = await call<{ found?: false; path?: string; tag?: string } & Record<string, unknown>>("fetch", {
          url, format: "tree", path: params.path, rootSelector: params.rootSelector, excludeSelectors: params.excludeSelectors, enhanced: params.enhanced, ignoreRobots: params.ignoreRobots,
        })
        if (node.found === false) {
          return output({ found: false, path: params.path, hint: "Inspect the full tree or query it to find a valid path." }, createWebDetails({
            operation: "tree-path", format: "tree", status: "empty", url, path: params.path,
          }))
        }
        return output(node, createWebDetails({ operation: "tree-path", format: "tree", url, path: String(node.path ?? params.path) }))
      }

      if (params.query?.trim()) {
        const result = await call<{ url: string; query: string; hits: Array<{ path: string; tag: string; score: number; snippet: string }> }>("fetch", {
          url, format: "tree", query: params.query, topN: params.topN, rootSelector: params.rootSelector, excludeSelectors: params.excludeSelectors, enhanced: params.enhanced, ignoreRobots: params.ignoreRobots,
        })
        return output(omitEmpty({ url: result.url, query: result.query, hits: result.hits.map((h) => omitEmpty({ ...h })) }), createWebDetails({
          operation: "tree-query",
          format: "tree",
          status: result.hits.length === 0 ? "empty" : "ok",
          url,
          query: params.query,
          hits: result.hits.length,
          items: result.hits.map((hit) => ({ url, title: `${hit.tag} · ${hit.path}` })),
        }))
      }

      const tree = await call<Record<string, unknown>>("fetch", { url, format: "tree", rootSelector: params.rootSelector, excludeSelectors: params.excludeSelectors, enhanced: params.enhanced, ignoreRobots: params.ignoreRobots })
      return output(tree, createWebDetails({ operation: "tree-full", format: "tree", url }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`tree fetch failed: ${message}`)
    }
  }

  async function handleSinglePage(params: Params) {
    const fmt = params.format ?? "markdown"
    const url = params.url ?? ""

    if (fmt === "tree") return handleTreeFormat(params)

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
    })

    if (raw.blocked === true) {
      return output({
        blocked: true,
        url,
        reason: "robots.txt",
        hint: "The site's robots.txt disallows crawling this URL. Try a different path or domain.",
      }, createWebDetails({ operation: "fetch", format: fmt, status: "blocked", url, blockedBy: "robots.txt" }))
    }

    const { content, cache } = splitCache(raw)
    const papyrus = await maybeIngestPage(params, url)

    if (fmt === "lean") {
      return output(withPapyrus(content, papyrus), createWebDetails({
        operation: "fetch", format: "lean", url,
        title: String(content.title ?? ""), wordCount: Number(content.wordCount ?? 0), cache, enhanced: params.enhanced,
        papyrusDocs: papyrus?.ingested.length,
      }))
    }

    if (fmt === "links") {
      const links = (content.bodyLinks as unknown[] | undefined) ?? []
      return output(withPapyrus(content, papyrus), createWebDetails({
        operation: "fetch", format: "links", url,
        title: String(content.title ?? ""), links: links.length, cache, enhanced: params.enhanced,
        items: links.map((link) => ({ url: (link as { href: string }).href, title: (link as { text: string }).text })),
        papyrusDocs: papyrus?.ingested.length,
      }))
    }

    if (fmt === "highlights") {
      const hits = (content.hits as unknown[] | undefined) ?? []
      const withHint = hits.length === 0 ? { ...content, hint: "No matches. Try broader terms or use format=markdown." } : content
      return output(withPapyrus(withHint, papyrus), createWebDetails({
        operation: "fetch", format: "highlights",
        status: hits.length === 0 ? "empty" : "ok",
        url, title: String(content.title ?? ""), query: params.query, hits: hits.length, cache, enhanced: params.enhanced,
        papyrusDocs: papyrus?.ingested.length,
      }))
    }

    // markdown (default)
    const truncated = content.truncated === true
    const withHint = truncated
      ? { ...content, hint: "Content was bounded. Use highlights, tree query/path, rootSelector, or a more specific request for complete evidence." }
      : content
    return output(withPapyrus(withHint, papyrus), createWebDetails({
      operation: "fetch", format: "markdown", url,
      title: String(content.title ?? ""), wordCount: Number(content.wordCount ?? 0), cache, enhanced: params.enhanced,
      truncated, complete: !truncated,
      papyrusDocs: papyrus?.ingested.length,
    }))
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
        description:
          "BFS depth. 0=single page (default). 1=page + all its links. N=N hops deep.",
      })
    ),
    maxPages: Type.Optional(
      Type.Number({
        description: "Hard cap on total pages when depth>0 (default 10).",
      })
    ),
    sameDomain: Type.Optional(
      Type.Boolean({
        description: "Only follow links on the same domain when depth>0 (default true).",
      })
    ),

    enhanced: Type.Optional(
      Type.Boolean({
        description:
          "When true, always uses a headless browser (playwright-core + system Chrome, stealth mode). " +
          "When false (default), direct fetch is used and Playwright kicks in automatically " +
          "only if the page is detected as JS-rendered.",
      })
    ),

    format: Type.Optional(
      Type.Union(
        [
          Type.Literal("markdown"),
          Type.Literal("lean"),
          Type.Literal("links"),
          Type.Literal("highlights"),
          Type.Literal("tree"),
        ],
        {
          description:
            "markdown=full body (default), lean=outline only, links=link list, highlights=BM25F chunks, tree=semantic DOM tree.",
        }
      )
    ),
    query: Type.Optional(
      Type.String({
        description: "Search phrase. Required for format=highlights. Optional for format=tree (searches the tree).",
      })
    ),
    path: Type.Optional(
      Type.String({
        description: "Dot-bracket path for format=tree navigation, e.g. article.section[1].pre[0].code",
      })
    ),
    topN: Type.Optional(
      Type.Number({
        description: "Max hits to return for format=tree with query (default 5).",
      })
    ),

    grep: Type.Optional(
      Type.String({
        description:
          "Filter cached pages by substring match on url, title, domain, or description. Only applies when url is omitted (local cache listing).",
      })
    ),
    offset: Type.Optional(
      Type.Number({
        description: "Skip first N results when listing or searching the local cache (pagination).",
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return from cache listing or search (default 20, hard cap 100 for listing, 10 for search).",
      })
    ),

    rootSelector: Type.Optional(
      Type.String({
        description:
          "CSS selector to scope extraction (e.g. \"article\"). Discards everything outside.",
      })
    ),
    excludeSelectors: Type.Optional(
      Type.String({
        description:
          "Comma-separated CSS selectors to remove before extraction (e.g. \"nav, footer, .sidebar\").",
      })
    ),
    tokenBudget: Type.Optional(
      Type.Number({
        description:
          "Approximate max tokens to return (~4 chars/token), capped at 10,000. Truncation carries explicit completeness markers.",
      })
    ),
    searchQuery: Type.Optional(
      Type.String({
        description:
          "Web search query. Pass instead of url when you don't know the exact URL. " +
          "Returns ranked results (url, title, snippet) from Brave/Tavily/Exa/DDG. " +
          "Use the returned URLs to fetch the actual page content.",
      })
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description:
          "Per-request fetch timeout in milliseconds (default 30 000). " +
          "Increase for slow sites; decrease to fail fast in latency-sensitive loops.",
      })
    ),

    ingest: Type.Optional(
      Type.Boolean({
        description:
          "When true, push the result into Papyrus (the context mesh) as a Doc artifact after a " +
          "successful single-page fetch (url, depth=0) or a searchQuery search. Explicit opt-in only " +
          "\u2014 never triggered by an ordinary fetch. Ignored for depth>0 crawls and local cache views " +
          "(no url/searchQuery). Response includes a papyrus field with the created Doc id(s).",
      })
    ),
    relatesTo: Type.Optional(
      Type.String({
        description: "Existing Papyrus artifact id to link the ingested Doc(s) to via 'references'. Only used with ingest=true.",
      })
    ),
    ignoreRobots: Type.Optional(
      Type.Boolean({
        description:
          "Explicit, audited opt-out of the robots.txt check for this one request. Never use by default — " +
          "only when a site's blanket disallow is a bandwidth/scraping-abuse guard rather than genuinely " +
          "private content, and you (a human) have directed this specific fetch. Every use is logged.",
      })
    ),
  })

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
      "  rootSelector    — CSS selector to scope to (e.g. \"article\"). Ignores everything else.",
      "  excludeSelectors — comma-separated selectors to strip (e.g. \"nav, footer, .ads\").",
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
    promptSnippet:
      "Fetch URL: format=markdown/lean/links/highlights, depth, rootSelector, tokenBudget",
    parameters: paramsSchema,
    renderCall(args, theme, context) { return renderWebFetchCall(args, theme, context) },
    renderResult(result, options, theme, context) { return renderWebFetchResult(result, options, theme, context) },

    // -------------------------------------------------------------------------
    // Router — routes to the correct path handler. One reason to change: routing
    // logic. Business logic lives in the daemon; this file's handlers only
    // shape daemon operation results into the tool's historical contract.
    // -------------------------------------------------------------------------
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.searchQuery?.trim()) return await handleSearch(params)

        if (!params.url) {
          if (params.query?.trim()) return await handleCacheSearch(params)
          return await handleCacheListing(params)
        }

        if ((params.depth ?? 0) > 0) return await handleCrawl(params)

        return await handleSinglePage(params)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`web_fetch failed: ${message}`)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Small local helper — omitEmpty was part of format.ts, which moved to the
// daemon package; kept here as the one remaining consumer (detail/content
// reshaping in this file only, not page formatting).
// ---------------------------------------------------------------------------
function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0),
    ),
  )
}
