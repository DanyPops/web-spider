/**
 * @dpopsuev/pi-web-spider
 *
 * Pi extension: one tool, web_fetch, with format and depth as parameters.
 *
 *   depth=0  (default) — fetch a single URL
 *   depth>0            — BFS crawl, returns per-page summaries, caches all pages
 *
 *   format=markdown    — full markdown body + metadata
 *   format=lean        — headings + links only, no body (~10-20x fewer tokens)
 *   format=links       — outbound links only
 *   format=highlights  — BM25F search the page(s), return matching text blocks
 *
 * Install:
 *   pi install git:github.com/dpopsuev/web-spider
 *
 * Search API keys (optional):
 *   BRAVE_SEARCH_API_KEY  — https://brave.com/search/api/ ($5 free/mo)
 *   TAVILY_API_KEY        — https://tavily.com ($1k free credits)
 *   EXA_API_KEY           — https://exa.ai (neural/semantic search)
 */
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { bodyLinks, highlightHit, leanOutput, linksOutput, markdownOutput, navLinksCount, omitEmpty } from "./format.js"

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Dynamic import bypasses jiti/Bun CJS interop, which can silently lose
  // class constructors when require()-ing ESM packages with "type":"module".
  // Native import() always uses the "import" condition and returns proper ESM.
  const lib = await import("@dpopsuev/web-spider")
  const { spider, crawl, searchPages, SpiderCache, PageGraph, PlaywrightHttpClient,
          queryTree, navigateTree } = lib

  // Shared Playwright browser — launched lazily on first use, reused across
  // all requests. Stealth plugin is applied automatically (patches ~15
  // headless fingerprint signals). Null if playwright-core is not installed.
  let playwrightClient: InstanceType<typeof PlaywrightHttpClient> | null = null
  const getPlaywrightClient = () => {
    if (!playwrightClient) playwrightClient = new PlaywrightHttpClient()
    return playwrightClient
  }

  // throttle.js and robots.js are loaded as side-effects of crawl.js before
  // index.js processes its own re-exports for them. Under jiti tryNative:false
  // (Bun binary mode) this causes their exports to be undefined via the barrel.
  // Sub-path imports don't work either — jiti resolves the package name from
  // the process cwd, which may find a different node_modules.
  // Solution: don't import those modules in the extension at all. crawl()
  // creates its own DomainThrottle and RobotsCache internally when none are
  // passed (respectRobots:true is the default). Single-page spider() calls
  // are one request and don't need session-level throttling.
  // Disk-backed cache — survives extension reloads and pi restarts.
  // Override paths via env vars:
  //   WEB_SPIDER_CACHE_PATH   — path to the pages JSON index
  //                             (default: ~/.cache/web-spider/pages.json)
  //   WEB_SPIDER_IMAGES_PATH  — directory for large binary image files
  //                             (default: ~/.cache/web-spider/images/)
  //                             DiskCache derives this automatically from the
  //                             cache file path, so this env var is for
  //                             informational/override use by the caller.
  // Falls back to in-memory SpiderCache if the path is not writable.
  const cache = (() => {
    const cachePath = process.env["WEB_SPIDER_CACHE_PATH"]
      ?? join(homedir(), ".cache", "web-spider", "pages.json")
    // Images dir: honour override env var, otherwise derive from cache path.
    // DiskCache always derives its own imagesDir from dirname(path)/images,
    // so this block just ensures the directory exists at startup.
    const imagesDir = process.env["WEB_SPIDER_IMAGES_PATH"]
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
  const corpus: lib.SpideredPage[] = []

  // ---------------------------------------------------------------------------
  // Per-request helpers
  // ---------------------------------------------------------------------------

  type Params = Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[1]

  /** Build spider options from tool params. */
  function buildSpiderOpts(params: Params) {
    return {
      rootSelector: params.rootSelector,
      excludeSelectors: params.excludeSelectors,
      tokenBudget: params.tokenBudget,
      timeoutMs: params.timeoutMs,
      httpClient: params.enhanced ? getPlaywrightClient() : undefined,
    }
  }

  /** Return a fetchPage function bound to session state and request params. */
  function buildFetchPage(params: Params) {
    const spiderOpts = buildSpiderOpts(params)
    return async (url: string): Promise<lib.SpideredPage> => {
      const hit = cache.get(url)
      if (hit) return hit
      let page = await spider(url, spiderOpts)
      if (page.jsRendered && !params.enhanced) {
        page = await spider(url, { ...spiderOpts, httpClient: getPlaywrightClient() })
      }
      cache.set(url, page)
      corpus.push(page)
      graph.addPage(page)
      return page
    }
  }

  // ---------------------------------------------------------------------------
  // Local materialized view helpers
  // ---------------------------------------------------------------------------

  /** All non-expired cached pages as an array. */
  function cachedPages(): lib.SpideredPage[] {
    return cache.values()
  }

  // ---------------------------------------------------------------------------
  // Path handlers — each owns one execution branch. SRP: one reason to change.
  // ---------------------------------------------------------------------------

  /** Crawl path: depth > 0. */
  async function handleCrawl(params: Params) {
    const spiderOpts = buildSpiderOpts(params)
    const fmt = params.format ?? "markdown"
    const depth = params.depth!

    const result = await crawl(params.url!, {
      maxDepth: depth,
      maxPages: params.maxPages ?? 10,
      sameDomainOnly: params.sameDomain ?? true,
      cache,
      graph,
      onPage: (page) => corpus.push(page),
      ...spiderOpts,
    })

    const pages = [...result.pages.values()]
    const errorsObj = result.errors.size
      ? { errors: result.errors.size, errorUrls: [...result.errors.keys()] }
      : {}

    if (fmt === "highlights") {
      if (!params.query?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "highlights format requires a query." }) }],
          details: {},
        }
      }
      const hits = searchPages(pages, params.query, { topN: 8, snippetRadius: 150 })
      return {
        content: [{ type: "text", text: JSON.stringify({
          query: params.query,
          pagesSearched: pages.length,
          hits: hits.map((h) => ({
            url: h.url,
            ...highlightHit(h, pages.find((p) => p.url === h.url)?.chunks ?? []),
          })),
        }) }],
        details: { format: "highlights", pagesSearched: pages.length, hits: hits.length },
      }
    }

    const summary = fmt === "lean"
      ? { pagesFound: result.pages.size, ...errorsObj, pages: pages.map(leanOutput) }
      : {
          pagesFound: result.pages.size,
          ...errorsObj,
          note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
          pages: pages.map((p) => omitEmpty({ url: p.url, title: p.title, description: p.description, wordCount: p.wordCount, tags: p.tags })),
        }

    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
      details: { depth, pagesFound: result.pages.size },
    }
  }

  // Separate in-memory tree cache — trees are large, session-scoped, not persisted.
  const treeCache = new Map<string, lib.DOMNode>()

  async function fetchTree(url: string, timeoutMs?: number): Promise<lib.DOMNode> {
    const hit = treeCache.get(url)
    if (hit) return hit
    const page = await spider(url, { view: "tree", timeoutMs })
    treeCache.set(url, page.tree)
    return page.tree
  }

  /**
   * Cache listing path: no url, no query.
   * Returns lean summaries of all cached pages, with grep/offset/limit filters.
   * Defaults to lean format — the full set could be hundreds of pages.
   */
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

    return {
      content: [{ type: "text", text: JSON.stringify({ ...meta, pages: slice.map(leanOutput) }) }],
      details: { format: "lean", total, filtered, offset, limit },
    }
  }

  /**
   * Cache search path: no url, query provided.
   * BM25F search across all cached pages (including previous sessions).
   */
  function handleCacheSearch(params: Params) {
    const pages = cachedPages()
    if (pages.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Local cache is empty. Fetch some pages first with depth=0 or depth>0." }) }],
        details: {},
      }
    }

    const topN = params.limit ?? 10
    const hits = searchPages(pages, params.query!, { topN, snippetRadius: 150 })
    return {
      content: [{ type: "text", text: JSON.stringify(omitEmpty({
        query: params.query,
        pagesSearched: pages.length,
        hits: hits.map((h) => ({
          url: h.url,
          ...highlightHit(h, pages.find((p) => p.url === h.url)?.chunks ?? []),
        })),
        hint: hits.length === 0 ? "No matches. Try broader terms, or list cached pages with web_fetch(format=lean) and no url." : undefined,
      })) }],
      details: { format: "highlights", pagesSearched: pages.length, hits: hits.length },
    }
  }

  /** Single-page path: depth === 0, url provided. */
  async function handleSinglePage(params: Params, fetchPage: ReturnType<typeof buildFetchPage>) {
    const fmt = params.format ?? "markdown"

    // ── Tree formats ───────────────────────────────────────────────────────────────
    if (fmt === "tree") {
      try {
        const tree = await fetchTree(params.url!, params.timeoutMs)

        // path= → navigate to a specific node
        if (params.path) {
          const node = navigateTree(tree, params.path)
          if (!node) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Path not found: ${params.path}` }) }],
              details: {},
            }
          }
          return {
            content: [{ type: "text", text: JSON.stringify(node) }],
            details: { format: "tree", mode: "navigate", tag: node.tag, path: node.path },
          }
        }

        // query= → search the tree (atomic hits — whole code blocks, whole table rows)
        if (params.query?.trim()) {
          const hits = queryTree(tree, params.query, { topN: params.topN ?? 5 })
          return {
            content: [{ type: "text", text: JSON.stringify(omitEmpty({
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
            })) }],
            details: { format: "tree", mode: "query", hits: hits.length },
          }
        }

        // no query, no path → return the full tree
        return {
          content: [{ type: "text", text: JSON.stringify(tree) }],
          details: { format: "tree", mode: "full" },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          details: {},
        }
      }
    }

    const page = await fetchPage(params.url!)

    if (fmt === "lean") {
      return {
        content: [{ type: "text", text: JSON.stringify(leanOutput(page)) }],
        details: { format: "lean", wordCount: page.wordCount },
      }
    }

    if (fmt === "links") {
      return {
        content: [{ type: "text", text: JSON.stringify(linksOutput(page)) }],
        details: { format: "links", bodyLinks: bodyLinks(page).length, navLinksCount: navLinksCount(page) },
      }
    }

    if (fmt === "highlights") {
      if (!params.query?.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "highlights format requires a query.",
            hint: "Pass query='what you are looking for', or use format=markdown to read the full page.",
          }) }],
          details: {},
        }
      }
      const hits = searchPages([page], params.query, { topN: 5, snippetRadius: 150 })
      return {
        content: [{ type: "text", text: JSON.stringify(omitEmpty({
          url: page.url,
          title: page.title,
          query: params.query,
          hits: hits.map((h) => highlightHit(h, page.chunks)),
          hint: hits.length === 0 ? "No matches. Try broader terms or use format=markdown." : undefined,
        })) }],
        details: { format: "highlights", hits: hits.length },
      }
    }

    // markdown (default)
    return {
      content: [{ type: "text", text: JSON.stringify(markdownOutput(page)) }],
      details: { format: "markdown", wordCount: page.wordCount },
    }
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a URL and return its content. Optionally crawl to a given depth.",
      "Can also search the web when searchQuery is provided instead of a URL.",
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
      "  robots.txt is checked and respected before each fetch.",
    ].join("\n"),
    promptSnippet:
      "Fetch URL: format=markdown/lean/links/highlights, depth, rootSelector, tokenBudget",
    parameters: Type.Object({
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
            "Approximate max tokens to return (~4 chars/token). Truncated at a line boundary.",
        })
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Per-request fetch timeout in milliseconds (default 10 000). " +
            "Increase for slow sites; decrease to fail fast in latency-sensitive loops.",
        })
      ),
    }),

    // -------------------------------------------------------------------------
    // Router — routes to the correct path handler. One reason to change: routing
    // logic. Business logic lives in the handlers above.
    // -------------------------------------------------------------------------
    async execute(_id, params) {
      try {
        const fetchPage = buildFetchPage(params)

        // Local materialized view path — no url: query the cache directly.
        if (!params.url) {
          if (params.query?.trim()) return handleCacheSearch(params)
          return handleCacheListing(params)
        }

        if ((params.depth ?? 0) > 0) return await handleCrawl(params)

        return await handleSinglePage(params, fetchPage)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          details: {},
        }
      }
    },
  })
}
