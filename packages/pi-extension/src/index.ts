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

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  // Dynamic import bypasses jiti/Bun CJS interop, which can silently lose
  // class constructors when require()-ing ESM packages with "type":"module".
  // Native import() always uses the "import" condition and returns proper ESM.
  const lib = await import("@dpopsuev/web-spider")
  const { spider, crawl, fuzzySearch, SpiderCache, PageGraph, webSearch, toLean } = lib

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
    label: "Web Fetch (@dpopsuev/web-spider v0.2.0)",
    description: [
      "Fetch a URL and return its content. Optionally crawl to a given depth.",
      "Can also search the web when searchQuery is provided instead of a URL.",
      "",
      "SEARCH",
      "  searchQuery       — search the web instead of fetching a URL.",
      "  searchEngine      — 'brave' or 'tavily'. Auto-detected from env vars.",
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
        Type.Union([Type.Literal("brave"), Type.Literal("tavily")], {
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
      const spiderOpts = {
        rootSelector: params.rootSelector,
        excludeSelectors: params.excludeSelectors,
        tokenBudget: params.tokenBudget,
        // throttle and robotsCache omitted — crawl() creates them internally;
        // spider() single-page calls don't need session-level throttling.
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
          // Fetch each result in lean format concurrently (up to 5 at once)
          const enriched = await Promise.allSettled(
            results.slice(0, params.numResults ?? 10).map((r) =>
              spider(r.url, { ...spiderOpts, view: "lean" })
                .then((page) => ({ ...r, page }))
                .catch(() => ({ ...r, page: null }))
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

        // For highlights across the crawl, run fuzzySearch on all fetched pages
        if (fmt === "highlights") {
          if (!params.query?.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "highlights format requires a query." }),
                },
              ],
              details: {},
            }
          }

          const pages = [...result.pages.values()]
          const hits = fuzzySearch(pages, params.query, { topN: 8, snippetRadius: 150 })

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query: params.query,
                  pagesSearched: pages.length,
                  hits: hits.map((h) => {
                    const page = pages.find((p) => p.url === h.url)
                    return {
                      url: h.url,
                      heading: h.heading,
                      score: h.score,
                      snippet: h.snippet,
                      text: h.chunkId
                        ? (page?.chunks.find((c) => c.id === h.chunkId)?.text ?? h.snippet)
                        : h.snippet,
                    }
                  }),
                }),
              },
            ],
            details: { format: "highlights", pagesSearched: pages.length, hits: hits.length },
          }
        }

        // Default crawl response
        const pageList = [...result.pages.values()]
        const summary = fmt === "lean"
          ? {
              pagesFound: result.pages.size,
              errors: result.errors.size,
              errorUrls: [...result.errors.keys()],
              pages: pageList.map((p) => toLean(p)),
            }
          : {
              pagesFound: result.pages.size,
              errors: result.errors.size,
              errorUrls: [...result.errors.keys()],
              note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
              pages: pageList.map((p) => ({
                url: p.url,
                title: p.title,
                description: p.description,
                wordCount: p.wordCount,
                tags: p.tags,
              })),
            }

        return {
          content: [{ type: "text", text: JSON.stringify(summary) }],
          details: { depth, pagesFound: result.pages.size },
        }
      }

      // -----------------------------------------------------------------------
      // Single-page path (depth = 0)
      // -----------------------------------------------------------------------

      // lean — skip body entirely
      if (fmt === "lean") {
        const page = await spider(params.url, { ...spiderOpts, view: "lean" })
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          details: { format: "lean" },
        }
      }

      // links — lean then extract just links
      if (fmt === "links") {
        const page = await spider(params.url, { ...spiderOpts, view: "lean" })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url: page.url, title: page.title, links: page.links }),
            },
          ],
          details: { format: "links", count: page.links.length },
        }
      }

      // Full fetch — markdown and highlights both need the page body
      let page: lib.SpideredPage
      const cached = cache.get(params.url)
      if (cached) {
        page = cached
      } else {
        page = await spider(params.url, spiderOpts)
        cache.set(params.url, page)
        corpus.push(page)
        graph.addPage(page)
      }

      // highlights — fuzzy-search the single page
      if (fmt === "highlights") {
        if (!params.query?.trim()) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "highlights format requires a query.",
                  hint: "Pass query='what you are looking for', or use format=markdown to read the full page.",
                }),
              },
            ],
            details: {},
          }
        }

        const hits = fuzzySearch([page], params.query, { topN: 5, snippetRadius: 150 })

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                url: page.url,
                title: page.title,
                query: params.query,
                hits:
                  hits.length === 0
                    ? []
                    : hits.map((h) => ({
                        heading: h.heading,
                        score: h.score,
                        snippet: h.snippet,
                        text: h.chunkId
                          ? (page.chunks.find((c) => c.id === h.chunkId)?.text ?? h.snippet)
                          : h.snippet,
                      })),
                hint:
                  hits.length === 0
                    ? "No matches. Try broader terms or use format=markdown."
                    : undefined,
              }),
            },
          ],
          details: { format: "highlights", hits: hits.length },
        }
      }

      // markdown — full page
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: page.url,
              domain: page.domain,
              title: page.title,
              description: page.description,
              author: page.author,
              publishedAt: page.publishedAt,
              tags: page.tags,
              wordCount: page.wordCount,
              readingTimeMinutes: page.readingTimeMinutes,
              headings: page.headings,
              markdown: page.markdown,
            }),
          },
        ],
        details: { format: "markdown", wordCount: page.wordCount },
      }
    },
  })
}
