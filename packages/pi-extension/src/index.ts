/**
 * @danypops/pi-web-spider — Pi extension exposing web_fetch.
 *
 * Install: pi install git:github.com/DanyPops/web-spider
 */
import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Static } from "typebox"
import type { SpideredPage, DOMNode } from "@danypops/web-spider"
import { bodyLinks, highlightHit, leanOutput, linksOutput, markdownOutput, omitEmpty } from "./format.js"
import { DEFAULT_FETCH_TOKEN_BUDGET, MAX_FETCH_TOKEN_BUDGET, TREE_CACHE_MAX_ENTRIES } from "./constants.js"
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
  // Dynamic import bypasses jiti/Bun CJS interop, which can silently lose
  // class constructors when require()-ing ESM packages with "type":"module".
  // Native import() always uses the "import" condition and returns proper ESM.
  const lib = await import("@danypops/web-spider")
  const { spider, crawl, searchPages, SpiderCache, PageGraph, PlaywrightHttpClient,
          queryTree, navigateTree, defaultSearchEngine, DomainThrottle, RobotsCache } = lib

  // Browser processes are expensive — one shared instance per session.
  let playwrightClient: InstanceType<typeof PlaywrightHttpClient> | null = null
  const getPlaywrightClient = () => {
    if (!playwrightClient) {
      // /nonexistent in tests forces an immediate launch failure rather than a hang.
      const executablePath = process.env.WEB_SPIDER_PLAYWRIGHT_EXECUTABLE
      playwrightClient = new PlaywrightHttpClient(executablePath ? { executablePath } : undefined)
    }
    return playwrightClient
  }

  // Diagnostics go only to a file — never to stdout/stderr, which belong to Pi's TUI.
  const diagPath = process.env.WEB_SPIDER_DIAG_PATH ?? join(homedir(), ".cache", "web-spider", "diag.log")
  const diag = (entry: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    try { appendFileSync(diagPath, `${line}\n`) } catch { /* best-effort */ }
  }
  const log = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => {
    diag({ level, msg, ...extra !== undefined ? { extra } : {} })
  }

  // throttle.js and robots.js become undefined via the barrel under jiti
  // tryNative:false (Bun binary mode) — they load as side-effects of crawl.js
  // before index.js finishes its own re-exports. crawl() creates its own
  // DomainThrottle / RobotsCache internally, so we don't need to import them.
  //
  // WEB_SPIDER_CACHE_PATH   — pages JSON index (default: ~/.cache/web-spider/pages.json)
  // WEB_SPIDER_IMAGES_PATH  — large image files; DiskCache derives this from
  //                           dirname(cachePath)/images, so set only to override.
  // Falls back to in-memory SpiderCache if the cache path is not writable.
  const cache = (() => {
    const cachePath = process.env.WEB_SPIDER_CACHE_PATH
      ?? join(homedir(), ".cache", "web-spider", "pages.json")
    const imagesDir = process.env.WEB_SPIDER_IMAGES_PATH
      ?? join(homedir(), ".cache", "web-spider", "images")
    try {
      const dir = dirname(cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })
      return new lib.DiskCache(cachePath, { maxSize: 500, ttlMs: 30 * 60 * 1000 })
    } catch {
      return new SpiderCache({ maxSize: 200, ttlMs: 30 * 60 * 1000 })
    }
  })()
  const graph = new PageGraph()

  {
    const storeRaw = (cache as unknown as Record<string, unknown>).store ??
                     (cache as unknown as Record<string, unknown>).map
    diag({
      tag: "boot-probe",
      cacheClass:  cache.constructor.name,
      storeTag:    Object.prototype.toString.call(storeRaw),
      storeIsMap:  storeRaw instanceof Map,
    })
  }
  // ---------------------------------------------------------------------------
  // Per-request helpers
  // ---------------------------------------------------------------------------

  type Params = Static<typeof paramsSchema>

  // Shared throttle + robots checker for single-page spider() calls.
  // (crawl() creates its own internally; these cover depth=0 fetches.)
  const sharedThrottle = new DomainThrottle({ minDelayMs: 500 })
  const sharedRobots = new RobotsCache()

  function buildSpiderOpts(params: Params) {
    return {
      rootSelector: params.rootSelector,
      excludeSelectors: params.excludeSelectors,
      tokenBudget: Math.min(params.tokenBudget ?? DEFAULT_FETCH_TOKEN_BUDGET, MAX_FETCH_TOKEN_BUDGET),
      timeoutMs: params.timeoutMs,
      httpClient: params.enhanced ? getPlaywrightClient() : undefined,
      throttle: sharedThrottle,
      robotsCache: sharedRobots,
    }
  }

  interface FetchPageResult {
    page: SpideredPage
    cache: "hit" | "miss"
  }

  function buildFetchPage(params: Params) {
    const spiderOpts = buildSpiderOpts(params)
    return async (url: string): Promise<FetchPageResult> => {
      const cacheEligible = !params.rootSelector && !params.excludeSelectors && params.tokenBudget === undefined && !params.enhanced
      let probe = "cache.get"
      try {
        const hit = cacheEligible ? cache.get(url) : undefined
        if (hit) return { page: hit, cache: "hit" }

        log("info", "fetching", { url, enhanced: params.enhanced ?? false })
        probe = "spider"
        let page = await spider(url, spiderOpts)
        log("info", "plain fetch done", { url, wordCount: page.wordCount, jsRendered: page.jsRendered })

        if (page.jsRendered && !params.enhanced) {
          log("info", "jsRendered detected, retrying with Playwright", { url })
          probe = "spider(playwright)"
          try {
            page = await spider(url, { ...spiderOpts, httpClient: getPlaywrightClient() })
            log("info", "Playwright fetch done", { url, wordCount: page.wordCount })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log("error", "Playwright fallback failed", { url, error: msg })
            throw new Error(`Playwright fallback failed: ${msg}`)
          }
        }

        probe = "cache.set"
        if (cacheEligible) cache.set(url, page)
        probe = "graph.addPage"
        graph.addPage(page)
        return { page, cache: "miss" }
      } catch (err) {
        diag({
          tag: "call-site-throw",
          probe,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6).join(" | ") : undefined,
        })
        throw err
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Local materialized view helpers
  // ---------------------------------------------------------------------------

  function cachedPages(): SpideredPage[] {
    return cache.values()
  }

  function pageWasTruncated(page: SpideredPage): boolean {
    return page.chunks.reduce((total, chunk) => total + chunk.wordCount, 0) < page.wordCount
  }

  function pageItems(pages: SpideredPage[]) {
    return pages.map((page) => ({ url: page.url, title: page.title }))
  }

  function output(payload: unknown, details: WebPresentationDetails) {
    return createWebResult(payload, details)
  }

  // ---------------------------------------------------------------------------
  // Path handlers — each owns one execution branch. SRP: one reason to change.
  // ---------------------------------------------------------------------------

  async function handleCrawl(params: Params) {
    const spiderOpts = buildSpiderOpts(params)
    const fmt = params.format ?? "markdown"
    const depth = params.depth ?? 0
    const url = params.url ?? ""

    const result = await crawl(url, {
      maxDepth: depth,
      maxPages: params.maxPages ?? 10,
      sameDomainOnly: params.sameDomain ?? true,
      cache,
      graph,
      ...spiderOpts,
    })

    const pages = [...result.pages.values()]
    const errorsObj = result.errors.size
      ? { errors: result.errors.size, errorUrls: [...result.errors.keys()] }
      : {}

    if (fmt === "highlights") {
      if (!params.query?.trim()) throw new Error("highlights format requires a query")
      const hits = searchPages(pages, params.query, { topN: 8, snippetRadius: 150 })
      return output({
        query: params.query,
        pagesSearched: pages.length,
        hits: hits.map((h) => ({
          url: h.url,
          ...highlightHit(h, pages.find((p) => p.url === h.url)?.chunks ?? []),
        })),
      }, createWebDetails({
        operation: "crawl",
        format: "highlights",
        url,
        query: params.query,
        depth,
        pages: pages.length,
        hits: hits.length,
        errors: result.errors.size,
        items: pageItems(pages),
      }))
    }

    const summary = fmt === "lean"
      ? { pagesFound: result.pages.size, ...errorsObj, pages: pages.map(leanOutput) }
      : {
          pagesFound: result.pages.size,
          ...errorsObj,
          note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
          pages: pages.map((p) => omitEmpty({ url: p.url, title: p.title, description: p.description, wordCount: p.wordCount, tags: p.tags })),
        }

    return output(summary, createWebDetails({
      operation: "crawl",
      format: fmt === "lean" ? "lean" : "markdown",
      url,
      depth,
      pages: result.pages.size,
      errors: result.errors.size,
      items: pageItems(pages),
    }))
  }

  // Trees are too large and volatile for DiskCache — session-scoped only.
  const treeCache = new Map<string, DOMNode>()

  async function fetchTree(url: string, params: Params): Promise<DOMNode> {
    const key = JSON.stringify([url, params.rootSelector ?? "", params.excludeSelectors ?? "", params.enhanced ?? false])
    const hit = treeCache.get(key)
    if (hit) return hit
    const page = await spider(url, { ...buildSpiderOpts(params), view: "tree" })
    if (treeCache.size >= TREE_CACHE_MAX_ENTRIES) {
      const oldest = treeCache.keys().next().value
      if (oldest) treeCache.delete(oldest)
    }
    treeCache.set(key, page.tree)
    return page.tree
  }

  function handleCacheListing(params: Params) {
    let pages = cachedPages()
    const total = pages.length

    if (params.grep?.trim()) {
      const pat = params.grep.toLowerCase()
      pages = pages.filter(
        (p) =>
          p.url.toLowerCase().includes(pat) ||
          p.title.toLowerCase().includes(pat) ||
          p.domain.toLowerCase().includes(pat) ||
          (p.description ?? "").toLowerCase().includes(pat),
      )
    }

    const filtered = pages.length
    const offset = params.offset ?? 0
    const limit = Math.min(params.limit ?? 20, 100) // hard cap at 100
    const slice = pages.slice(offset, offset + limit)
    const remaining = filtered - offset - slice.length

    const meta = omitEmpty({
      total,
      filtered: filtered !== total ? filtered : undefined,
      offset: offset || undefined,
      limit,
      remaining: remaining > 0 ? remaining : undefined,
    })

    return output({ ...meta, pages: slice.map(leanOutput) }, createWebDetails({
      operation: "cache-list",
      format: "lean",
      status: slice.length === 0 ? "empty" : "ok",
      pages: filtered,
      cache: "listing",
      items: pageItems(slice),
      truncated: remaining > 0,
      complete: remaining <= 0,
    }))
  }

  function handleCacheSearch(params: Params) {
    const pages = cachedPages()
    if (pages.length === 0) {
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

    const topN = params.limit ?? 10
    const hits = searchPages(pages, params.query ?? "", { topN, snippetRadius: 150 })
    return output({
      ...omitEmpty({ query: params.query, pagesSearched: pages.length }),
      hits: hits.map((h) => ({
        url: h.url,
        ...highlightHit(h, pages.find((p) => p.url === h.url)?.chunks ?? []),
      })),
      ...(hits.length === 0 ? { hint: "No matches. Try broader terms, or list cached pages with web_fetch(format=lean) and no url." } : {}),
    }, createWebDetails({
      operation: "cache-search",
      format: "highlights",
      status: hits.length === 0 ? "empty" : "ok",
      query: params.query,
      pages: pages.length,
      hits: hits.length,
      cache: "search",
      items: pageItems(pages.filter((page) => hits.some((hit) => hit.url === page.url))),
    }))
  }

  async function handleSinglePage(params: Params, fetchPage: ReturnType<typeof buildFetchPage>) {
    const fmt = params.format ?? "markdown"
    const url = params.url ?? ""

    // ── Tree formats ───────────────────────────────────────────────────────────────
    if (fmt === "tree") {
      try {
        const tree = await fetchTree(url, params)

        // path= → navigate to a specific node
        if (params.path) {
          const node = navigateTree(tree, params.path)
          if (!node) {
            return output({ found: false, path: params.path, hint: "Inspect the full tree or query it to find a valid path." }, createWebDetails({
              operation: "tree-path",
              format: "tree",
              status: "empty",
              url,
              path: params.path,
            }))
          }
          return output(node, createWebDetails({
            operation: "tree-path",
            format: "tree",
            url,
            path: node.path,
          }))
        }

        // query= → search the tree (atomic hits — whole code blocks, whole table rows)
        if (params.query?.trim()) {
          const hits = queryTree(tree, params.query, { topN: params.topN ?? 5 })
          return output(omitEmpty({
            url: params.url,
            query: params.query,
            hits: hits.map((h) => omitEmpty({
              path: h.path,
              tag: h.node.tag,
              score: Math.round(h.score * 100) / 100,
              snippet: h.snippet,
              text: h.node.text,
              childCount: h.node.children?.length,
            })),
          }), createWebDetails({
            operation: "tree-query",
            format: "tree",
            status: hits.length === 0 ? "empty" : "ok",
            url,
            query: params.query,
            hits: hits.length,
            items: hits.map((hit) => ({ url, title: `${hit.node.tag} · ${hit.path}` })),
          }))
        }

        // no query, no path → return the full tree
        return output(tree, createWebDetails({
          operation: "tree-full",
          format: "tree",
          url,
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`tree fetch failed: ${message}`)
      }
    }

    if (fmt === "highlights" && !params.query?.trim()) throw new Error("highlights format requires a query")

    const fetched = await fetchPage(url)
    const page = fetched.page

    if (fmt === "lean") {
      return output(leanOutput(page), createWebDetails({
        operation: "fetch",
        format: "lean",
        url: page.url,
        title: page.title,
        wordCount: page.wordCount,
        cache: fetched.cache,
        enhanced: params.enhanced,
      }))
    }

    if (fmt === "links") {
      const links = bodyLinks(page)
      return output(linksOutput(page), createWebDetails({
        operation: "fetch",
        format: "links",
        url: page.url,
        title: page.title,
        links: links.length,
        cache: fetched.cache,
        enhanced: params.enhanced,
        items: links.map((link) => ({ url: link.href, title: link.text })),
      }))
    }

    if (fmt === "highlights") {
      const query = params.query ?? ""
      const hits = searchPages([page], query, { topN: 5, snippetRadius: 150 })
      return output({
        ...omitEmpty({ url: page.url, title: page.title, query: params.query }),
        hits: hits.map((h) => highlightHit(h, page.chunks)),
        ...(hits.length === 0 ? { hint: "No matches. Try broader terms or use format=markdown." } : {}),
      }, createWebDetails({
        operation: "fetch",
        format: "highlights",
        status: hits.length === 0 ? "empty" : "ok",
        url: page.url,
        title: page.title,
        query: params.query,
        hits: hits.length,
        cache: fetched.cache,
        enhanced: params.enhanced,
      }))
    }

    // markdown (default)
    const truncated = pageWasTruncated(page)
    return output({
      ...markdownOutput(page),
      ...(truncated ? {
        truncated: true,
        hint: "Content was bounded. Use highlights, tree query/path, rootSelector, or a more specific request for complete evidence.",
      } : {}),
    }, createWebDetails({
      operation: "fetch",
      format: "markdown",
      url: page.url,
      title: page.title,
      wordCount: page.wordCount,
      cache: fetched.cache,
      enhanced: params.enhanced,
      truncated,
      complete: !truncated,
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
    ].join("\n"),
    promptSnippet:
      "Fetch URL: format=markdown/lean/links/highlights, depth, rootSelector, tokenBudget",
    parameters: paramsSchema,
    renderCall(args, theme) { return renderWebFetchCall(args, theme) },
    renderResult(result, options, theme, context) { return renderWebFetchResult(result, options, theme, context) },

    // -------------------------------------------------------------------------
    // Router — routes to the correct path handler. One reason to change: routing
    // logic. Business logic lives in the handlers above.
    // -------------------------------------------------------------------------
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const fetchPage = buildFetchPage(params)

        // Web search path — searchQuery instead of url.
        if (params.searchQuery?.trim()) {
          try {
            const engine = defaultSearchEngine()
            const results = await engine.search({ query: params.searchQuery, numResults: params.limit ?? 10 })
            log("info", "web search done", { query: params.searchQuery, hits: results.length })
            return output({
              query: params.searchQuery,
              results,
              hint: "Use the url field from a result to fetch its full content with web_fetch(url=...).",
            }, createWebDetails({
              operation: "search",
              format: "search",
              status: results.length === 0 ? "empty" : "ok",
              query: params.searchQuery,
              hits: results.length,
              items: results.map((result) => ({ url: result.url, title: result.title })),
            }))
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`web search failed: ${message}`)
          }
        }

        // Local materialized view path — no url: query the cache directly.
        if (!params.url) {
          if (params.query?.trim()) return handleCacheSearch(params)
          return handleCacheListing(params)
        }

        if ((params.depth ?? 0) > 0) return await handleCrawl(params)

        return await handleSinglePage(params, fetchPage)
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Blocked by robots.txt:")) {
          return output({
            blocked: true,
            url: params.url,
            reason: "robots.txt",
            hint: "The site's robots.txt disallows crawling this URL. Try a different path or domain.",
          }, createWebDetails({
            operation: (params.depth ?? 0) > 0 ? "crawl" : "fetch",
            format: params.format ?? "markdown",
            status: "blocked",
            url: params.url,
            depth: params.depth,
            blockedBy: "robots.txt",
          }))
        }
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`web_fetch failed: ${message}`)
      }
    },
  })
}
