# `web_fetch` — API Reference

> Pi extension tool · `@danypops/pi-web-spider`

`web_fetch` fetches a URL and returns structured content, crawls a site to arbitrary depth, or searches the web — all through a single tool call. Every response is JSON.

---

## Quick decision guide

| Goal | Call |
|---|---|
| Read a page | `{ url }` |
| Skim a page before reading | `{ url, format: "lean" }` |
| Extract outbound links | `{ url, format: "links" }` |
| Read JSON or textual API content | `{ url, format: "source" }` |
| Find specific text on a page | `{ url, format: "highlights", query: "…" }` |
| Inspect page structure | `{ url, format: "tree" }` |
| Navigate to one node | `{ url, format: "tree", path: "article.section[1]" }` |
| Crawl a whole site | `{ url, depth: 2, maxPages: 20 }` |
| Search the web | `{ searchQuery: "…" }` |
| Search recent news | `{ searchQuery: "…", timeRange: "month", topic: "news" }` |
| Save a page to the Papyrus context mesh | `{ url, ingest: true }` |

---

## Parameters

### Input — choose one

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | Fully-qualified `http(s)://` URL to fetch or crawl. |
| `searchQuery` | `string` | Web search query. Searches the web instead of fetching a URL. Requires at least one search API key to be set in the **daemon's own environment** (see [Search engines](#search-engines)) — never passed by the caller. |

Pass either `url` or `searchQuery` for network work. Omitting both queries the local materialized cache: `query` performs full-text search, while no query lists cached pages.

---

### Format

| Parameter | Type | Default | Description |
|---|---|---|---|
| `format` | `"markdown"` \| `"lean"` \| `"links"` \| `"highlights"` \| `"tree"` \| `"source"` | `"markdown"` | Controls the shape of the returned content (see [Formats](#formats)). |

---

### Depth / crawl

| Parameter | Type | Default | Description |
|---|---|---|---|
| `depth` | `number` | `0` | BFS hop depth. `0` = single page. `1` = page + all linked pages. `N` = N hops deep. |
| `maxPages` | `number` | `10` | Hard cap on total pages fetched when `depth > 0`. |
| `sameDomain` | `boolean` | `true` | When `depth > 0`, only follow links on the same domain as the start URL. |

When `depth > 0`, all fetched pages are cached in the session. Subsequent `depth=0` calls to any cached URL are free (no network).

---

### Content scoping

| Parameter | Type | Description |
|---|---|---|
| `rootSelector` | `string` | CSS selector. Scope extraction to the matched element; everything outside is discarded. Example: `"article"`, `".main-content"`, `"#post-body"`. |
| `excludeSelectors` | `string` | Comma-separated CSS selectors to strip before extraction. Example: `"nav, footer, .sidebar, #ads"`. |
| `tokenBudget` | `number` | Approximate max tokens to return (`~4 chars/token`), capped at 10,000. Truncation is chunk-aware where possible and always carries an explicit completeness marker. |

---

### Format-specific

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | `string` | — | **Required** for `format: "highlights"`. Search phrase matched against page chunks using BM25F ranking. Optional for `format: "tree"` — searches the semantic DOM tree instead. |
| `path` | `string` | — | `format: "tree"` only. Dot-bracket path to navigate to a specific node, e.g. `"article.section[1].pre[0].code"`. |
| `topN` | `number` | `5` | `format: "tree"` with `query` only. Max hits to return. |

---

### Search

| Parameter | Type | Description |
|---|---|---|
| `searchEngine` | `"brave"` \| `"tavily"` \| `"exa"` \| `"serper"` \| `"serpapi"` \| `"you"` | Force a specific engine. Auto-detected from available API keys when omitted. |
| `numResults` | `number` | Number of search results (default `10`). |
| `timeRange` | `"day"` \| `"week"` \| `"month"` \| `"year"` | Restrict results to content published within this window. Supported by Tavily and Brave. Use `"month"` when asked for recent or latest news. |
| `topic` | `"news"` \| `"general"` | Search topic mode. `"news"` prioritises freshly indexed news articles (Tavily only). Combine with `timeRange: "month"` for the freshest results. |
| `siteFilter` | `string` | Restrict results to one domain (e.g. `"reddit.com"`). Routed by which configured engine has actually returned matching results for that domain before -- some domains (Reddit, which blocked most search engines' crawlers in 2024) have real coverage from only a subset of providers regardless of which one is asked first. |
| `wantFullContent` | `boolean` | Declares intent -- "give me full page content alongside each result" -- without naming a provider. Routed to whichever configured engine can actually supply it (Tavily, Exa); engines that can't ignore it, same as an unsupported `timeRange`. Populates each result's `content` field. |

---

### Enhanced mode (JS rendering)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `enhanced` | `boolean` | `false` | When `true`, always uses a headless Chrome browser (playwright-core + stealth plugin) to render the page before extraction. Use for SPAs, JS-heavy pages, or sites with basic bot detection. When `false`, direct HTTP fetch is used and Playwright auto-kicks in if the page is detected as JS-rendered (`jsRendered: true`). |

---

### Network

| Parameter | Type | Default | Description |
|---|---|---|---|
| `timeoutMs` | `number` | `10000` | Per-request fetch timeout in milliseconds. Increase for slow sites; decrease to fail fast. |
| `ignoreRobots` | `boolean` | `false` | Explicit, audited bypass of the robots.txt check for this one request. See [Throttling & robots.txt](#throttling--robotstxt). |

---

## Formats

### `markdown` (default)

Full prose body plus actionable metadata. Use when you need to read the page.

```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "description": "Meta description",
  "author": "Jane Smith",
  "publishedAt": "2025-03-01",
  "wordCount": 1240,
  "markdown": "# Article Title\n\n## Section…"
}
```

Omitted: `domain`, `readingTimeMinutes`, `headings` (already in body), `links`, `chunks`, `fetchedAt`, `lang`, all empty strings/arrays.

---

### `lean`

Metadata + outline + body links. No prose. Use for triage — is this page relevant, and where next?

```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "wordCount": 1240,
  "headings": ["# Article Title", "## Section One", "## Section Two"],
  "bodyLinks": [
    { "href": "https://arxiv.org/abs/…", "text": "ReAct paper" }
  ],
  "navLinksCount": 28
}
```

`~5–20× fewer tokens` than `markdown`. `navLinksCount` surfaces how many navigation links (menus, footers) were found without flooding the output.

---

### `links`

Outbound links only. Use for graph traversal.

```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "bodyLinks": [
    { "href": "https://example.com/related", "text": "Related article" }
  ],
  "navLinksCount": 28
}
```

---

### `highlights`

BM25F search — returns matching chunks with scores. Requires `query`. Use when you know what you're looking for and don't want to read the full page.

```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "query": "rate limiting",
  "hits": [
    {
      "heading": "Throttling",
      "score": 0.91,
      "text": "Requests are rate-limited per domain…"
    }
  ]
}
```

When `depth > 0`, `highlights` searches across **all cached pages** from that crawl — pass `query` to search the whole corpus in one call.

---

### `source`

Normalized textual source for structured APIs and non-HTML resources. This is deliberately **not** byte-for-byte wire data: complete JSON is pretty-printed, HTML is represented by its extracted Markdown, and cache hits return the same normalized content as misses.

```json
{
  "url": "https://api.example.com/items/42",
  "contentType": "application/json",
  "content": "{\n  \"id\": 42,\n  \"active\": true\n}",
  "complete": true,
  "truncated": false
}
```

Malformed JSON and JSONL remain textual source rather than being mislabeled as parsed JSON. Binary media types are rejected. When `tokenBudget` or the Pi delivery limit truncates content, `complete` is `false` and `truncated` is `true`; partial JSON is never claimed to be a complete document. `source` is a single-page (`depth: 0`) format.

---

### `tree`

Collapsed semantic DOM tree — `div`/`span` stripped, only meaningful tags survive. Use to understand page structure without fetching the full body.

**Full tree** (`format: "tree"`, no `query` or `path`):
```json
{
  "tag": "article",
  "path": "article",
  "children": [
    { "tag": "h1", "path": "article.h1", "text": "Title" },
    { "tag": "section", "path": "article.section", "children": [ … ] }
  ]
}
```

**Search** (`format: "tree"`, `query: "…"`):
```json
{
  "url": "…",
  "query": "authentication",
  "hits": [
    { "path": "article.section[2].pre[0].code", "tag": "code", "score": 0.88, "snippet": "…" }
  ]
}
```

Hits are atomic — whole code blocks, whole table rows. Nodes that contain the matched text are never split.

**Navigate** (`format: "tree"`, `path: "article.section[1].pre[0].code"`):
```json
{ "tag": "code", "path": "article.section[1].pre[0].code", "text": "const x = 1", "attrs": { "lang": "typescript" } }
```

Tree is cached per session — `tree` then `tree+query` then `tree+path` cost one network request.

---

## Crawl output

When `depth > 0`, returns a summary rather than full page content:

```json
{
  "pagesFound": 12,
  "note": "All pages cached — use web_fetch(depth=0, format=highlights, query=…) to search them.",
  "pages": [
    { "url": "…", "title": "…", "description": "…", "wordCount": 820, "tags": [] }
  ]
}
```

With `format: "lean"`, each entry in `pages` is a full lean page object.

---

## Search output

```json
{
  "query": "web scraping AI agents",
  "results": [
    {
      "url": "https://example.com/article",
      "title": "Article Title",
      "snippet": "Short description from the engine.",
      "publishedAt": "2025-01-15"
    }
  ]
}
```

---

## Search engines

Every keyed engine with an API key set is round-robined as an equal-tier peer, spreading quota consumption instead of always hitting one first. Firecrawl's official keyless `/v2/search` endpoint is the bounded last resort, so search works with zero configuration. It is rate/credit limited per IP and may return an actionable `429`; configure a keyed provider for higher and more predictable limits.

| Engine | Env var | Notes |
|---|---|---|
| Brave | `BRAVE_SEARCH_API_KEY` | Full web index. $5 free/month. |
| Tavily | `TAVILY_API_KEY` | AI-optimised. $1 000 free credits. Also the reference `searchForAnswer()` implementation (synthesized, cited answer instead of a results list) via Tavily's own `include_answer`. |
| Exa | `EXA_API_KEY` | Neural/semantic search. |
| Serper | `SERPER_API_KEY` | Google-backed SERP API. |
| SerpApi | `SERPAPI_API_KEY` | Scraped, real Google SERPs. |
| You.com | `YOU_API_KEY` | Independent index, multiple pre-ranked snippets per result. |

Brave and Exa can each return more per result than the default `snippet` field alone: Brave's `extra_snippets` (on by default, no extra vendor cost per Brave's own docs) and Exa's opt-in full-page `text` extraction both surface through `highlights`/`content` on the same `WebSearchResult` shape as Tavily and You.com.

Force a specific engine with `searchEngine: "brave"` | `"tavily"` | `"exa"` | `"serper"` | `"serpapi"` | `"you"`.

A key can also live outside the daemon's raw process environment: `web-spider search-key set <engine>` stores it in a small local file instead (useful since a systemd `--user` service's environment is not actually scoped to what it needs), and Enigma can supply it too if configured. See the daemon README's "The full ladder" section for the exact precedence.

DuckDuckGo's Instant Answer API was previously used as a zero-cost last-resort fallback; it remains removed. It is not a web search index and returns empty-success for most queries. The Firecrawl fallback uses an official structured web-search contract instead. If a keyed provider fails and Firecrawl is empty or blocked, Web Spider preserves the earlier actionable provider error rather than repeating the old empty-success masking bug.

### Site-restricted queries and per-domain routing

Some domains block most search engines' crawlers outright -- Reddit updated its robots.txt in 2024 to disallow every crawler except Google's (and whoever licenses Google's index, e.g. Kagi), so Bing, DuckDuckGo, and most independent-index engines return little to no recent Reddit content regardless of query. Passing `siteFilter: "reddit.com"` restricts results to that domain and routes the query by which *configured* engine has actually returned matching results for it before -- an engine with no real coverage of the site is learned once (not re-paid on every call) and tried last, while the verdict still expires after 24h so a later-fixed engine isn't written off forever. Works automatically for a literal `site:domain.tld` operator typed directly into the query text too, not just the structured `siteFilter` parameter.

### Declarative intent, not provider names

`siteFilter` and `wantFullContent` are both intent flags, not provider selectors: you declare *what* you want, never *which engine* produces it. The underlying `@danypops/web-spider` package routes each to whichever configured provider can actually satisfy it (falling through gracefully, not erroring, when none can) -- the same principle covers a not-yet-daemon-exposed `wantAnswer` flag at the package level for a synthesized, cited answer instead of a results list, resolved by capability rather than by naming Tavily specifically. `searchEngine` remains available as an explicit escape hatch (forcing one named provider) for debugging or cost control, but it's the exception, not the primary way to ask for something.

---

## Context mesh (Papyrus ingestion)

| Parameter | Type | Description |
|---|---|---|
| `ingest` | `boolean` | When `true`, pushes the fetched page or search results into [Papyrus](https://github.com/DanyPops/papyrus) as Doc artifact(s) (`subtype: "web"` / `"web-search-result"`) after a successful single-page fetch (`depth: 0`) or a `searchQuery` search. **Explicit opt-in only** — never triggered by an ordinary fetch or search. Ignored for `depth > 0` crawls and local cache views (no `url`/`searchQuery`). |
| `relatesTo` | `string` | Existing Papyrus artifact ID to link the ingested Doc(s) to via `references`. Only used with `ingest: true`. |

When `ingest: true` succeeds, the response gains a `papyrus` field:

```json
{ "papyrus": { "ingested": [{ "url": "https://example.com", "docId": "example-abcd" }], "skipped": [] } }
```

Ingested Docs are immutable service output — a verbatim capture of what the source said at fetch time, never rewritten in place. Re-ingesting the same URL later creates a **new** Doc, not an edit. Ingestion requires a running, authenticated Papyrus daemon; if Papyrus isn't reachable, the call fails closed with Papyrus's own actionable error rather than silently doing nothing.

---

## Native presentation and output bounds

Pi receives two independent result channels:

- model-facing `content` is canonical JSON containing the requested prose, snippets, links, tree data, or search results. It is capped at 50,000 characters and includes deterministic `truncated`, `originalCharacters`, and guidance fields when incomplete;
- renderer-facing `details` is a versioned, runtime-validated metadata DTO containing only operation, format, identity, counts, cache/browser state, completeness, and at most 20 URL/title identities.

Fetched markdown, tree nodes, snippets, highlights, and provider responses are never copied into persisted `details`. Collapsed rendering uses details only. Expanded rendering presents the canonical model content directly, including themed Markdown for page bodies. Legacy or malformed details fall back to bounded content.

## Throttling & robots.txt

- Requests are automatically rate-limited **per domain** (500 ms minimum delay).
- On `429` / `503`, backs off exponentially and respects `Retry-After` headers (up to 3 retries).
- `robots.txt` is fetched, parsed, and respected before each page fetch. Blocked URLs return a normal typed `{ "blocked": true, "reason": "robots.txt" }` outcome; they are not reported as successful fetches.
- `ignoreRobots: true` explicitly bypasses this check for one request (fetch or crawl). Never a default — use only for a human-directed one-off fetch of a specific page you already know is fine to retrieve (e.g. a blanket `Disallow: /` that guards against bandwidth/scraping abuse rather than genuinely private content), not for autonomous bulk crawling. Every use is logged by the daemon (structured, not silent) since it's a deliberate policy override.

---

## Cache

Pages are cached by the **Web Spider daemon** — a supervised Bun process, not the Pi extension — in a SQLite database at `$XDG_DATA_HOME/web-spider/web-spider.db` (default `~/.local/share/web-spider/web-spider.db`; TTL 30 min, max 500 entries). The daemon auto-starts transparently on first `web_fetch` call if it isn't already running; see `packages/web-spider-daemon/README.md` for the full daemon/CLI reference and `service install` for making it survive reboots.

On the daemon's first-ever startup, a pre-daemon `~/.cache/web-spider/pages.json` (the old per-process JSON cache), if present, is imported once, then renamed to `pages.json.migrated` — nothing is lost, and the import never runs again once the cache is non-empty. `WEB_SPIDER_CACHE_PATH` still overrides where that legacy file is looked for, if it lived somewhere non-default.

Large images (>32 KB) spill to `$XDG_DATA_HOME/web-spider/images/` automatically — there is no separate `WEB_SPIDER_IMAGES_PATH` override in the daemon architecture (that was a library-only `DiskCache` option that does not carry over).

---

## Error handling

Invalid input, HTTP/network failures, search-provider failures, parser failures, and browser failures throw through Pi's native tool-error channel. Expected empty searches, missing tree paths, cache misses, and robots denial remain typed non-success outcomes.

Common cases:

| Condition | Native result |
|---|---|
| Non-HTTP URL | thrown `Invalid URL` / `Unsupported protocol` failure |
| HTTP error | thrown `HTTP 404 Not Found — https://…` failure |
| Timeout | thrown timeout failure |
| robots.txt blocked | typed blocked result |
| Missing highlights query | thrown validation failure before network access |
| Search provider unavailable | thrown provider failure |
| JS-rendered page | Playwright auto-fallback; a browser failure throws natively |
