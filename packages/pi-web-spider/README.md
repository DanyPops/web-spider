# @danypops/pi-web-spider

Web fetch, web search, and real browser sessions for [Pi](https://github.com/earendil-works/pi) — an agent-ready alternative to raw HTML scraping.

```
pi install npm:@danypops/pi-web-spider
```

## Tools

### `web_fetch`
Fetch a URL, crawl N hops deep, or search the web — one tool, three modes:

- **Fetch**: `url` → clean markdown, lean outline, link list, BM25F highlights, or a semantic tree. JSON/text is normalized, while PDFs get bounded text-layer extraction with `pdfPageStart`/`pdfPageEnd` (1-based, inclusive, maximum 50 pages). Image-only PDFs report `contentOk: false` rather than implying OCR.
- **Crawl**: `url` + `depth` → BFS crawl same-domain links, `robots.txt`-respecting and per-domain throttled, with an explicit audited `ignoreRobots` opt-out for a human-directed one-off.
- **Search**: `searchQuery` instead of `url` → real ranked results instead of a guessed slug. Routes across whichever of Brave, Brave LLM Context, Tavily, Exa, Serper, SerpApi, and You.com you've configured, round-robining for quota spread and falling back automatically on a rate limit or empty result.
- **Cache query**: omit `url` entirely → full-text search or filter (domain, tag, curated category, date range) over every page already fetched, disk-backed, survives restarts, zero network cost.

Structured extraction beats generic scraping where a real API exists: GitHub (REST/GraphQL), MediaWiki (Wikipedia and any MediaWiki wiki), `llms.txt`, and `.md`-suffix docs (AWS-docs-style) are recognized and queried directly.

### `web_session`
Persistent, named browser sessions for pages that need real interaction, not a single fetch: type into search boxes, select dropdowns, wait on async results, read a table. Supports navigate/click/hover/type/select/waitFor, structured extraction (`queryText`/`readTable`), accessibility-tree snapshots, screenshots, native dialog handling, file downloads, tab management, and console/network capture.

### `web_category`
Your own curated relevance categories over cached pages (e.g. "Code", "PTP Protocol") — distinct from a page's domain or its publisher's own tags. A page can belong to more than one category; assign, remove, rename, or list.

## Architecture

A supervised daemon (`@danypops/web-spider-daemon`) owns the SQLite page cache and every network fetch, crawl, throttle, and robots.txt check. This extension is a thin authenticated client — it never touches the network or a cache file directly, and auto-starts the daemon transparently on first use.

```
pi web_fetch / web_session / web_category
      ↓
this extension (thin client)
      ↓
authenticated loopback daemon → web-spider-daemon
      ↓
SQLite (WAL) cache · fetch/PDF/crawl/search execution · optional Papyrus ingestion
```

## Configuring search

Search works without configuration through Firecrawl's bounded keyless fallback. For higher and more predictable limits, set a provider API key as an environment variable (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SERPER_API_KEY`, `SERPAPI_API_KEY`, `YOU_API_KEY`) or store it locally:

```bash
web-spider search-key set brave
```

Configured providers are tried before keyless Firecrawl; configuring more than one gets automatic round-robin quota spreading plus fallback — no code changes, just more keys.

## Running as a service

The daemon auto-starts on first tool call. For persistence across reboots/logins (and to forward search keys into a systemd `--user` unit, which does not inherit the installing shell's environment):

```bash
web-spider service install
```

## Learn more

- [`docs/web-fetch-api.md`](https://github.com/DanyPops/web-spider/blob/main/docs/web-fetch-api.md) — full `web_fetch` parameter/output reference
- [`docs/web-session-api.md`](https://github.com/DanyPops/web-spider/blob/main/docs/web-session-api.md) — full `web_session` reference
- [`packages/web-spider-daemon/README.md`](https://github.com/DanyPops/web-spider/blob/main/packages/web-spider-daemon/README.md) — daemon architecture, CLI reference, service install

## Security

This extension executes with full system access, like any Pi extension. Review the source before installing.
