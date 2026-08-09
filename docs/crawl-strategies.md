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
