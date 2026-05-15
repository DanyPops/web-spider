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
 *   format=highlights  — fuzzy-search the page(s), return matching text blocks
 *
 * Install:
 *   pi install git:github.com/dpopsuev/web-spider
 *
 * Search API keys (optional):
 *   BRAVE_SEARCH_API_KEY  — https://brave.com/search/api/ ($5 free/mo)
 *   TAVILY_API_KEY        — https://tavily.com ($1k free credits)
 */
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
  const { spider, crawl, fuzzySearch, SpiderCache, PageGraph, webSearch, PlaywrightHttpClient } = lib

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
  const cache = new SpiderCache({ maxSize: 200, ttlMs: 30 * 60 * 1000 })
  const graph = new PageGraph()
  const corpus: lib.SpideredPage[] = []

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a URL and return its content. Optionally crawl to a given depth.",
      "Can also search the web when searchQuery is provided instead of a URL.",
      "",
      "SEARCH",
      "  searchQuery       — search the web instead of fetching a URL.",
      "  searchEngine      — 'brave', 'tavily', or 'exa'. Auto-detected from env vars.",
      "  numResults        — number of results (default 10).",
      "  Requires BRAVE_SEARCH_API_KEY or TAVILY_API_KEY environment variable.",
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
      "  highlights — fuzzy-search the page and return matching text blocks.",
      "               Requires `query`. Returns up to 5 scored chunks with context.",
      "               Use instead of reading full markdown when you know what to find.",
      "               Works across all cached pages when depth>0.",
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
      "Fetch URL or search: format=markdown/lean/links/highlights, searchQuery, depth, rootSelector, tokenBudget",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Fully-qualified http(s) URL to fetch or crawl from" })),

      searchQuery: Type.Optional(
        Type.String({
          description:
            "Web search query. When provided, searches the web instead of fetching a URL. " +
            "Requires BRAVE_SEARCH_API_KEY or TAVILY_API_KEY env var.",
        })
      ),
      searchEngine: Type.Optional(
        Type.Union([Type.Literal("brave"), Type.Literal("tavily"), Type.Literal("exa")], {
          description: "Search engine. Auto-detected from available API keys if omitted.",
        })
      ),
      numResults: Type.Optional(
        Type.Number({ description: "Number of search results (default 10)." })
      ),
      searchEnrich: Type.Optional(
        Type.Boolean({
          description:
            "When true, auto-fetch each search result in lean format and return lean pages " +
            "alongside search results. Saves a round-trip for search-then-triage workflows.",
        })
      ),

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
          ],
          {
            description:
              "markdown=full body (default), lean=outline only, links=link list, highlights=search result blocks.",
          }
        )
      ),
      query: Type.Optional(
        Type.String({
          description: "Search phrase. Required for format=highlights.",
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
    }),

    async execute(_id, params) {
      const fmt = params.format ?? "markdown"
      const depth = params.depth ?? 0

      // enhanced=true  → always use headless Playwright (stealth mode)
      // enhanced=false → direct fetch(); Playwright auto-fallback if jsRendered
      const httpClient = params.enhanced ? getPlaywrightClient() : undefined

      const spiderOpts = {
        rootSelector: params.rootSelector,
        excludeSelectors: params.excludeSelectors,
        tokenBudget: params.tokenBudget,
        httpClient,
      }

      // Fetch, apply Playwright fallback on jsRendered, and cache.
      // All single-page formats go through here so the cache is shared.
      const fetchPage = async (url: string): Promise<lib.SpideredPage> => {
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

      // -----------------------------------------------------------------------
      // Search path
      // -----------------------------------------------------------------------
      if (params.searchQuery) {
        const results = await webSearch(params.searchQuery, {
          engine: params.searchEngine,
          numResults: params.numResults ?? 10,
        })

        if (params.searchEnrich) {
          const enriched = await Promise.allSettled(
            results.slice(0, params.numResults ?? 10).map((r) =>
              fetchPage(r.url)
                .then((page) => omitEmpty({
                  url: r.url,
                  title: r.title,
                  snippet: r.snippet,
                  publishedAt: r.publishedAt,
                  wordCount: page.wordCount,
                  headings: page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
                }))
                .catch(() => ({ url: r.url, title: r.title, snippet: r.snippet }))
            )
          )
          return {
            content: [{ type: "text", text: JSON.stringify({
              query: params.searchQuery,
              results: enriched.map((r) => r.status === "fulfilled" ? r.value : null).filter(Boolean),
            }) }],
            details: { engine: params.searchEngine ?? "auto", count: results.length, enriched: true },
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ query: params.searchQuery, results }) }],
          details: { engine: params.searchEngine ?? "auto", count: results.length },
        }
      }

      if (!params.url) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Provide either url or searchQuery." }) }],
          details: {},
        }
      }

      // -----------------------------------------------------------------------
      // Crawl path (depth > 0)
      // -----------------------------------------------------------------------
      if (depth > 0) {
        const result = await crawl(params.url, {
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
          const hits = fuzzySearch(pages, params.query, { topN: 8, snippetRadius: 150 })
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

      // -----------------------------------------------------------------------
      // Single-page path (depth = 0)
      // -----------------------------------------------------------------------
      const page = await fetchPage(params.url)

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
        const hits = fuzzySearch([page], params.query, { topN: 5, snippetRadius: 150 })
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
    },
  })
}
