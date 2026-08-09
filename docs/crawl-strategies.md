# Crawl frontier ordering, page classification, and stop bookkeeping

`crawl()` is a depth-bounded BFS crawler. Before content-adaptive crawl features
(`page_type` classification, `content_ok`, `discover_only`/`crawl_urls`,
`max_total_chars`/`deadline_ms` budgets) were added on top of it, three small
Strategy boundaries were extracted from what used to be inline logic repeated
across `crawl()`'s frontier loop.

## Contract and dependency direction

- **`LinkScorer`** (`src/crawl/frontier.ts`) scores one discovered candidate
  URL given its discovery context (depth, source page, and — for in-page
  links — the `Link` itself). `crawl()` orders each frontier level by score,
  highest first, ties broken by discovery order. The default
  `InsertionOrderLinkScorer` scores every candidate equally, so ordering is
  unchanged from plain BFS discovery order. A future best-first scorer
  (focus relevance, content-likelihood, shallow-depth preference) is just
  another `LinkScorer` implementation — no change to `crawl()`'s loop.
- **`PageClassifier`** (`src/crawl/classifier.ts`) classifies one
  already-fetched `SpideredPage` — analogous to `ContentExtractor`
  (`docs/content-extractors.md`): pure, no network/cache/robots/throttle/
  Vehicle/daemon/SQLite/Pi work. The default `DefaultPageClassifier` reuses
  `spider()`'s existing `jsRendered` signal to report `"js_shell"` honestly
  and reports `"unknown"` otherwise — it does not invent an article/list
  distinction that doesn't exist yet. `crawl()` records each page's
  classification in `CrawlResult.classifications`, keyed by URL.
- **`CrawlBudget`** (`src/crawl/budget.ts`) owns "should we stop fetching"
  bookkeeping, replacing three separate `pages.size + errors.size`
  comparisons that used to be repeated across `crawl()`'s `shouldVisit` gate,
  main-loop guard, and remaining-slot calculation. The default
  `MaxPagesBudget` reproduces today's page-count-only cap exactly. Additional
  caps (total extracted characters, wall-clock deadline) are additive
  extensions — another implementation of the same two-method port, not a
  rewrite of `crawl()`'s loop.

All three are injectable via `CrawlOptions.linkScorer` / `.pageClassifier` /
`.budget`, mirroring `ContentExtractionOptions`'s existing DI style. Core
orchestration (`crawl()`) depends on the structural interfaces; it has no
compile-time dependency on any specific scoring/classification/budget
implementation.

## Deliberate limits

These are narrow, two-or-fewer-method Strategy ports, not abstract classes,
service locators, or a generic plugin framework — the same restraint already
established by `ContentExtractor` and the `ISearchEngine` composites. No
`page_type`/`content_ok` fields were added to the public `SpideredPage`/
`CrawlOptions` contract in this refactor; that is additive feature work for a
later task, once this seam already exists to build it on.

## Content-adaptive crawl (built on the above seam)

`crawl()`'s defaults were upgraded from the inert `InsertionOrderLinkScorer`/
`DefaultPageClassifier` to real implementations of the same two ports —
matching the OCR fallback precedent (`docs/pdf-ocr-fallback.md`): a genuine
capability upgrade, not an opt-in flag, because the plain versions remain
exported for a caller that wants unweighted BFS or minimal classification.

- **`HeuristicLinkScorer`**: boosts URL paths matching `/docs/`, `/guide/`,
  `/api/`, `/blog/`, `/article/`, `/reference/`; penalizes `/login/`,
  `/signin/`, `/signup/`, `/register/`, `/cart/`, `/checkout/`, `/submit/`,
  `/logout/`, `/account/`, `/settings/`; and slightly prefers shallower
  depth as a tie-break. Pure string/URL inspection — no network or DOM work.
- **`HeuristicPageClassifier`**: classifies `"js_shell"` from the existing
  `jsRendered` signal; `"list"` from high link density relative to word
  count (>=15 links, <400 words — an index/nav-shaped page); `"article"`
  from substantial word count (>=100 words); otherwise `"unknown"`. An
  extractor that already reported `contentOk:false` (e.g. a scanned PDF) is
  never overridden with a false-confidence classification.
- **Content-adaptive shaping, not re-extraction**: `PageClassifier.classify()`
  only sees an already-fully-extracted `SpideredPage` — the `ContentExtractor`
  Strategy has already run inside `spider()` by the time `crawl()` sees a
  page, so "content-adaptive extraction" cannot mean re-running extraction
  with a different strategy without a much larger, unwarranted structural
  change. Instead, `crawl()` honestly *reshapes* a `"list"`-classified page's
  `markdown` into a clean rendered link list before storing it, leaving
  `title`/`description`/`links`/`wordCount` untouched. This is a deliberate,
  documented interpretation, not a claim that extraction itself is adaptive.
- **`discoverOnly`**: still requires one real fetch per page (link discovery
  is impossible without reading the page's HTML — there is no cheaper
  "headers only" path in this architecture), but strips `markdown`/`chunks`
  from what is stored/returned, giving an honest "URL map, no content body"
  contract rather than a literal no-fetch claim.
- **`crawlUrls`**: an alternative entry mode — when non-empty, the frontier
  is exactly `crawlUrls` (still filtered through `shouldVisit`/budget), no
  sitemap seeding runs, and no further link-following happens after that one
  batch, regardless of `maxDepth` — "selective crawl of a chosen subset, no
  re-discovery" taken literally.
- **`DefaultCrawlBudget`**: combines `maxPages` (existing), `maxTotalChars`
  (sum of each fetched page's `markdown.length`, tracked by `crawl()` and
  passed in `CrawlBudgetState.charsUsed`), and `deadlineMs` (default
  120000ms, compared against `CrawlBudgetState.elapsedMs`, also tracked by
  `crawl()`). A budget is a pure function of the state `crawl()` computes —
  it owns no clock of its own, keeping `CrawlBudget` implementations trivial
  to unit test without fake timers. Its optional `reason(state)` method
  reports *why* it is exhausted, surfaced as `CrawlResult.nextAction`
  (`"complete" | "max-pages" | "max-total-chars" | "deadline"`) — a crawl
  that simply ran out of frontier is `"complete"`, not budget-limited.

No composed/decorator budget chain was introduced for the three caps — one
small class checking three conditions is proportionate; the `CrawlBudget`
port itself remains the real swappable extension point for a caller wanting
an entirely different policy.
