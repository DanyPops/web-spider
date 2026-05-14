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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { spider, crawl, fuzzySearch, SpiderCache, PageGraph } from "@dpopsuev/web-spider"
import type { SpideredPage } from "@dpopsuev/web-spider"

// ---------------------------------------------------------------------------
// Session-scoped cache and corpus
// ---------------------------------------------------------------------------

const cache = new SpiderCache({ maxSize: 200, ttlMs: 30 * 60 * 1000 })
const graph = new PageGraph()
const corpus: SpideredPage[] = []

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: [
      "Fetch a URL and return its content. Optionally crawl to a given depth.",
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
    ].join("\n"),
    promptSnippet:
      "Fetch a URL (or crawl depth=N): format=markdown/lean/links/highlights, rootSelector, tokenBudget",
    parameters: Type.Object({
      url: Type.String({ description: "Fully-qualified http(s) URL to fetch or crawl from" }),

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
                  text: JSON.stringify({
                    error: "highlights format requires a query.",
                  }),
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

        // Default crawl response: summary of all pages found
        const summary = {
          pagesFound: result.pages.size,
          errors: result.errors.size,
          errorUrls: [...result.errors.keys()],
          note: "All pages cached — use web_fetch(depth=0, format=highlights, query=...) to search them.",
          pages: [...result.pages.values()].map((p) => ({
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
      let page: SpideredPage
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
