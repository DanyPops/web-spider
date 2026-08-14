# @danypops/web-spider-daemon

Supervised Bun daemon for `@danypops/web-spider`: an authenticated loopback service for fetch/crawl/search/cache operations. Follows the same architecture as [`@danypops/papyrus`](https://github.com/DanyPops/papyrus) and [`@danypops/jittor`](https://github.com/DanyPops/jittor) — a single supervised process owns SQLite; every other consumer (Pi extension, CLI) talks to it through an authenticated typed client.

## Architecture

```text
web_fetch tool / CLI
      ↓
WebSpiderClient → authenticated loopback daemon (127.0.0.1, bearer token)
      ↓
operation registry (service.ts)
      ↓
ports (PageStore, ...) → SQLite adapters (WAL)
```

The daemon binds `127.0.0.1` on an OS-assigned port — never a fixed or externally reachable port — and writes its handle only after a successful bind. Every HTTP request (including `/health`) requires `Authorization: Bearer <token>`.

Bun-independent consumers can share the authenticated discovery implementation through precompiled Facade exports; neither subpath imports SQLite, Playwright, or daemon process composition:

```ts
import { connectWebSpiderClient } from "@danypops/web-spider-daemon/client";
import { resolveWebSpiderPaths } from "@danypops/web-spider-daemon/state";
```

Both exports are tested under native Node ESM and Jiti with `tryNative` enabled and disabled.

## Storage and service

```text
$XDG_DATA_HOME/web-spider/web-spider.db      # SQLite WAL, daemon-owned
$XDG_STATE_HOME/web-spider/auth-token        # 0600, 64 hex chars
$XDG_RUNTIME_DIR/web-spider/daemon.json      # 0600, { host, port, pid }
$XDG_CONFIG_HOME/systemd/user/armada-web-spider.service # Armada-owned native descriptor
```

## Install

```bash
bun install
bun src/cli.ts service install   # registers with Armada, reconciles, and starts the native service
bun src/cli.ts service status
bun src/cli.ts service restart
bun src/cli.ts service stop
```

Armada owns `armada-web-spider.service`. On systemd it runs `bun <cli.ts> serve` with restart-on-failure, `NoNewPrivileges=true`, `PrivateTmp=true`, and network-online ordering. These are required portable runtime capabilities: Armada fails explicitly rather than silently dropping them on an unsupported native manager.

Run without installing a service (foreground, for development):

```bash
bun src/cli.ts serve
```

## Upgrade

Reinstalling the service (`service install`) updates Armada desired state against the currently installed `bun`/`cli.ts` paths, reconciles the native descriptor, and restarts the daemon; the SQLite database, auth token, local provider keys, and cached pages are untouched by an upgrade. A newer package version that bumps the internal SQLite schema version applies its migration automatically on the next `serve` startup — schema migrations here are forward-only and versioned via `PRAGMA user_version`, matching Papyrus/Jittor.

## Uninstall

```bash
bun src/cli.ts service stop
armada remove web-spider --json
```

Removing the Armada registration does not delete the SQLite database, auth token, or daemon handle files (`$XDG_DATA_HOME/web-spider`, `$XDG_STATE_HOME/web-spider`, `$XDG_RUNTIME_DIR/web-spider`) — delete those directories directly if a full reset is wanted.

## Operations

The current operation registry (see `src/service.ts`):

| Operation | Description |
|---|---|
| `cache.list` | Paginated listing of cached pages (bounded: limit ≤ 100), filterable by `grep` (substring), `domain` (exact), `tag` (auto-extracted), `category` (curated, see below), and `fetchedAfter`/`fetchedBefore`/`publishedAfter`/`publishedBefore` time ranges; sortable by `fetchedAt`/`publishedAt`/`url`/`domain` |
| `cache.search` | BM25F search across cached pages (full chunk text, not a truncated snippet) |
| `search` | Live web search via Brave/Tavily/Exa/Serper/SerpApi/You.com, provider fallback chain, `numResults`/`timeRange`/`topic`/`searchEngine`/`siteFilter`/`wantFullContent` -- the latter two are declarative ("restrict to this domain" / "give me full page content"), routed to whichever configured provider can satisfy them rather than naming one |
| `search.usage` | Per-call usage/cost data each engine itself reported (`credits` for Tavily, `costUsd` for Exa, `rateLimitHeaders` for Brave when present) -- append-only, bounded to the most recent 10,000 rows, filterable by `engine`. Never a running account balance: no provider's search API exposes one, only what one call cost. |
| `fetch` | Single-page fetch — `markdown`/`lean`/`links`/`highlights`/`tree`/`source` formats, `rootSelector`/`excludeSelectors`/`tokenBudget`, bounded PDF `pdfPageStart`/`pdfPageEnd` with an automatic OCR fallback for empty/garbled pages (`pdf.ocrPages`/`pdf.qualityScore`), `enhanced` (Playwright). Robots-blocked pages return `{ blocked: true, reason: "robots.txt" }` instead of throwing. |
| `quotes` | Standalone resource-finder: given a `query` and an explicit `urls` list (typically a prior `search` call's results, ≤ 50), fetches each one and returns ranked, verbatim BM25F quotes per url as "resource cards" (`{ url, title?, author?, publishedAt?, quotes }` or `{ url, error }` for a url that failed to fetch) -- never an LLM-digested answer. `maxQuotesPerUrl` (default 3, ≤ 20) bounds each url's own share so one page can't starve the others; `maxQuotesTotal` (default 15, ≤ 100) bounds the combined count. Each quote carries a `citationUrl` -- a standards-based [URL Text Fragment](https://wicg.github.io/scroll-to-text-fragment/) deep link a real browser navigates to and highlights, distinct from the internal `chunkId`. Independent of `crawl`'s frontier/depth machinery -- it never discovers new URLs, only extracts from the ones it's given. |
| `crawl` | Depth-bounded BFS crawl — `depth` (≤ 5), `maxPages` (≤ 200), `sameDomain`, `discoverOnly`, `crawlUrls` (≤ 50), `maxTotalChars`, `deadlineMs` (≤ 300000), same formats as `fetch` plus a crawl summary. Best-first orders content-likely pages, classifies each page's `pageType`/`contentOk`, and reports why the crawl stopped via `nextAction`. Bounds are enforced server-side regardless of what a caller requests. |
| `papyrus.ingest` | Explicit opt-in: turns already-cached pages (`kind: "pages"`, by URL) or a caller-supplied search-result set (`kind: "search"`) into Papyrus `doc` artifacts (`subtype: "web"` / `"web-search-result"`), optionally linked to an existing artifact via `relatesTo`. Bounded to 20 items per call. Ingested Docs are immutable service output — never updated in place; re-ingesting the same URL creates a new Doc. Reaches Papyrus only through its own authenticated client, never its SQLite file directly. |
| `session.create` | Launches a named, isolated Playwright browser **process** with one explicit context shared by that session's tabs — tmux-style session semantics. Named sessions never share a browser/context, while tabs in one session share cookies, cache, and origin storage. Bounded to 5 concurrent sessions; rejects past the ceiling rather than queuing. Defaults to Playwright's bundled Chromium in headless mode. `headed: true` opens a visible window for human CAPTCHA/login/consent takeover while keeping the same persistent session for later agent automation; `forceChromeChannel: true` uses the full installed Chrome. |
| `session.list` | Lists active sessions with their `snapshotVersion` and activity timestamps. |
| `session.close` | Finalizes a named session context-before-browser and returns a structured per-stage report (`ok`/`error`/`timeout`). Success is destination-idempotent; a failure retains the runtime so the same close can be retried instead of losing cleanup ownership. Each stage is bounded to 10 seconds by default. |
| `session.act` | Dispatches one `navigate`/`click`/`eval`/`screenshot` action against a session's persistent page. Requires the caller's `snapshotVersion` to match the session's current one — fails closed (HTTP 409) if the page has navigated or changed since the caller last observed it, rather than silently acting on stale state. Committed top-level browser navigation advances the active page's `snapshotVersion`, including human link/form navigation, reload, and history changes; DOM-only and subframe changes do not. Every call — successful, rejected, or failed — is recorded in an append-only, content-free audit journal (SQLite `session_audit_log`, bounded to the most recent 10,000 rows): action, outcome, and a redacted target (a sanitized URL for `navigate`, the selector for `click`, and a fixed `"<script>"`/`"<screenshot>"` placeholder for `eval`/`screenshot` — script source and image bytes are never written to the journal, only returned to the caller). |
| `category.assign` | Curated, agent/user-assignable relevance category for a cached page (distinct from `domain`/`tags` — a judgment about what a page is *for*, not mechanical metadata). Creates the category on first use; assigning twice is a no-op. A page can belong to any number of categories at once. |
| `category.remove` | Removes a category from a page. Idempotent — no error if already absent. |
| `category.rename` | Renames a category everywhere it's used in one step (categories have a real id, not free text per page). Renaming into an already-existing name merges the two rather than erroring. |
| `category.list` | Lists every known category with its page count. |

Provider API keys (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SERPER_API_KEY`, `SERPAPI_API_KEY`, `YOU_API_KEY`) can be read from the daemon's environment for foreground/development launches, but service credentials should use the local key store or Enigma. They are never passed through an operation input or projected into Armada. Every configured keyed provider is round-robined as an equal-tier peer (spreading query volume so no single provider's quota gets hammered first), each with its own cooldown after a rate-limit-shaped failure. With no key, or after configured providers return no results, `search` uses Firecrawl's official bounded keyless endpoint; its per-IP rate/credit limits remain actionable errors, and an empty/blocked keyless attempt never masks an earlier keyed-provider failure. Throttling (500ms per-domain minimum) and robots.txt checking use daemon-process-wide singletons, replacing the pi-extension's previous per-session instances.

`service install` deliberately ignores provider API keys and `ENIGMA_CLIENT_TOKEN`: secrets never enter Armada manifests or generated native descriptors. Configure provider keys with `web-spider search-key set <engine>`, or use Enigma's shared token file and the persistent opt-in below.

### Optional: a local, per-engine key file instead of an env var

`web-spider search-key set <engine>` stores an API key in its own small file under this daemon's state directory (`search-keys/<engine>.json`, 0600, plaintext), independent of the process environment entirely:

```bash
web-spider search-key set tavily       # hidden prompt, or WEB_SPIDER_SEARCH_KEY_VALUE=... for scripts
web-spider search-key list             # engine names only, never the keys themselves
web-spider search-key remove tavily
```

This exists because a systemd `--user` service's env is not actually scoped to what it needs — it inherits the whole desktop session's environment, secrets included. A locally stored key sidesteps that: it lives in a file only this daemon's own state directory holds, and it overrides a same-named env var rather than being overridden by it. Takes effect on the daemon's next restart (`resolveSearchEnv()` resolves once at startup, not per search call).

### Optional: BYOK key stacking (several keys per provider)

`search-key set` replaces the whole stored list with exactly one key. `search-key add` stacks an additional key alongside whatever is already stored for that engine instead:

```bash
web-spider search-key set tavily     # first key
web-spider search-key add tavily     # a second key, stacked (not a replacement)
web-spider search-key list           # still just engine names, never key values or counts
web-spider search-key test tavily    # live-tests every stored key, reporting valid/rate-limited/invalid by position
```

With more than one key stored for a provider, that provider's engine is wrapped in a `RotatingKeySearchEngine` (`@danypops/web-spider`): a 429 rotates to the next key for the *same* provider within the same call (60s cooldown for the rate-limited key before it's tried again); a 401/403 marks that key invalid for 300s. Falling back to a *different* provider only happens once every key for this one is exhausted -- rotation state is in-memory only and resets on the daemon's next restart, same as the env/Enigma tiers' own lifecycle. `search-key test` makes one real, minimal call per stored key through the daemon (network egress is daemon-owned) and never returns or logs a raw key -- only its position and classified status.

### Optional: credentials via Enigma, instead of a static key per provider

Enigma involvement is opt-in. Run `web-spider enigma enable` to persist the non-secret choice in `$XDG_STATE_HOME/web-spider/enigma.json`; `web-spider enigma disable` and `web-spider enigma status` manage it. Without the opt-in, the daemon never probes for Enigma merely because one is reachable. The legacy `WEB_SPIDER_USE_ENIGMA` flag remains available for foreground launches and explicit overrides.

With the opt-in enabled, the daemon asks Enigma at startup which provider backends it's registered for (`enigma client add`) and fills in each one's declared env var from the vault, ahead of whatever the daemon's own environment already has. Nothing is hardcoded — Enigma is the source of truth for both which backends this daemon has and which env var each one maps to (set once, at `enigma login apikey --env-var ...` time).

Registering the client itself is Enigma's own administrative step (`enigma client add web-spider --backends ...`, printing a token once) and may need to run under Enigma's own service account rather than yours, depending on how Enigma is deployed — see Enigma's own docs for that part. Once Enigma's shared token file is available to the daemon's account, enable the integration and restart:

```bash
web-spider enigma enable
web-spider service restart

enigma login apikey --name Brave --env-var BRAVE_SEARCH_API_KEY
enigma client add web-spider --backends brave,tavily,exa
# -> stores the client registration in Enigma; the daemon uses Enigma's shared token file
```

Without `ENIGMA_CLIENT_TOKEN`, Enigma's shared admin-token file is deliberately unreadable outside its own service account — the daemon falls straight through to its own environment's static keys, unchanged from before Enigma existed.

### The full ladder

Each engine resolves its key in this order, strongest wins:

1. Enigma, if the persistent opt-in is enabled (or `WEB_SPIDER_USE_ENIGMA=1`) and a credential is registered
2. This daemon's own local key file (`search-key set`)
3. The raw process environment (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, ...)

Each rung is independently optional; using only the env var works identically to before either of the other two existed.

`tree.query`/`tree.path` as standalone operations (today folded into `fetch(format: "tree")`), `robots.status`, `throttle.status`, `searchEnrich` composition, and `papyrus.ingest` land in follow-up work.

## CLI

Every registered operation has a CLI route using the authenticated client only — the CLI never opens SQLite directly. Human-readable output by default; `--json` prints the exact operation result for scripting.

```bash
web-spider fetch <url> [--format markdown|lean|links|highlights|tree|source] [--depth N] [--max-pages N]
                        [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]
                        [--token-budget N] [--pdf-page-start N] [--pdf-page-end N] [--enhanced]
                        [--timeout-ms N] [--query TEXT] [--path DOTPATH] [--top-n N]
                        [--discover-only] [--crawl-urls URL,URL,...] [--max-total-chars N] [--deadline-ms N] [--json]
web-spider search <query> [--num-results N] [--time-range day|week|month|year] [--topic news|general]
                        [--engine brave|tavily|exa|serper|serpapi|you] [--site-filter DOMAIN] [--json]
web-spider usage [--engine NAME] [--limit N] [--json]
web-spider cache list [--grep TEXT] [--domain TEXT] [--tag TEXT] [--fetched-after MS] [--fetched-before MS]
                        [--published-after ISO] [--published-before ISO]
                        [--sort-by fetchedAt|publishedAt|url|domain] [--sort-order asc|desc] [--offset N] [--limit N] [--json]
web-spider cache search <query> [--limit N] [--json]
web-spider category assign <url> <category> [--json]
web-spider category remove <url> <category> [--json]
web-spider category rename <category> <newName> [--json]
web-spider category list [--json]
web-spider papyrus ingest <url...> [--relates-to ARTIFACT_ID] [--json]
web-spider session create <name> [--headed] [--force-chrome-channel] [--json]
web-spider session list [--json]
web-spider session close <name> [--json]
web-spider session act <name> --action navigate --snapshot-version N --url URL [--timeout-ms N] [--json]
web-spider session act <name> --action click --snapshot-version N --selector CSS [--timeout-ms N] [--json]
web-spider session act <name> --action eval --snapshot-version N [--script-file PATH] [--json]
web-spider session act <name> --action screenshot --snapshot-version N [--json]
web-spider daemon diagnose [--history-limit N] [--json]
```

`session act --action eval` never accepts the script as a plain flag value (shell history and `ps` would leak it) — it reads the script from `--script-file PATH`, or from stdin if that's omitted:

```bash
echo "document.title" | web-spider session act agent1 --action eval --snapshot-version 0
web-spider session act agent1 --action eval --snapshot-version 0 --script-file ./check.js
```

Every `session act` call needs the session's current `snapshotVersion` (from `session create`'s response or the previous `act` call's response) — an out-of-date version is rejected rather than silently acting against a page that may have already navigated elsewhere.

For a human-in-the-loop CAPTCHA/login handoff, create the session with `--headed --force-chrome-channel`, navigate to the blocked page, let the user complete the step in the visible Chrome window, then continue `session act` calls against the same session. If the challenge was first discovered in an already-headless session, close and recreate that session headed; Playwright cannot reveal an existing headless process in place.

`papyrus ingest` requires each URL to already be cached (`web-spider fetch <url>` first) and requires a running, authenticated Papyrus daemon — it fails closed with Papyrus's own actionable "daemon is not running" message when Papyrus isn't installed or started. It is never automatic: nothing is pushed to Papyrus except in direct response to this explicit call.

`fetch` and `crawl` share one command: `--depth N` (N > 0) or `--crawl-urls URL,URL,...` (a selective, no-re-discovery crawl of exactly those URLs, even without `--depth`) routes to the `crawl` operation, matching the `web_fetch` tool's own single-entry-point shape. Bounds (`depth` ≤ 5, `maxPages` ≤ 200, `crawlUrls` ≤ 50 entries, `deadlineMs` ≤ 300000ms, etc.) are enforced by the daemon regardless of what the CLI requests.

`daemon diagnose` reports this daemon's own current instance identity (`instanceId`/`pid`/`startedAt`/`provenance`) plus its recent restart history (`started`/`already_running`/`stopped`/`crashed` events, each carrying an instance id, pid, timestamp, and shutdown reason where applicable) -- bounded to the 50 most recent events, surviving a restart (backed by `@danypops/vehicle-server`'s shared daemon-lifecycle log, a persistent file under this daemon's own state directory). Use it to tell whether the daemon is flapping without reading its state files directly: `--history-limit N` bounds how much history comes back, defaulting to everything retained.

### UI-audit toolkit (internal library, not yet a daemon operation)

`src/layout-check.ts` measures real rendered geometry (`getBoundingClientRect()` + `getComputedStyle()` padding, via a session's page) for a set of CSS selectors and asserts a given layout property is consistent across all of them within a pixel tolerance — reporting the actual disagreeing values, not just pass/fail. Built to catch exactly the kind of bug that motivated this whole toolkit: agent-deck's message bubbles and tool-call card silently drifting to different padding.

`src/contrast-check.ts` measures each selector's real rendered foreground color and its *effective* background — resolved by walking up the ancestor chain and alpha-compositing every layer, so a `background: transparent` element correctly inherits whatever's actually painted behind it — and computes the WCAG 2.1 contrast ratio. Thresholds match doc `design-tokens-red-hat-informed-not-red-hat-branded-rm7c`: 4.5:1 for text under 18pt/24px, 3:1 for large text (18pt+, or 14pt+ bold) and informative icons/graphics. Catches the bug that motivated the whole toolkit: near-invisible dark-red text on a near-black background in agent-deck's Observability tab.

Neither is yet exposed as a `session.*`-style operation/CLI command — that lands in the follow-up task that wires both checkers into an actual regression gate run against agent-deck.

## Health and readiness

Both endpoints require the bearer token:

```bash
curl -H "Authorization: Bearer $(cat $XDG_STATE_HOME/web-spider/auth-token)" \
  http://127.0.0.1:$(cat $XDG_RUNTIME_DIR/web-spider/daemon.json | jq .port)/health
```

- `GET /health` — `{ ok: true, version, schema: { current, required } }`
- `GET /ready` — `{ ready: true }` once the HTTP server has bound; used by `packed`/other tooling to detect the daemon before calling operations
- `GET /api/v1/ops` — lists registered operation names
- `POST /api/v1/ops` — `{ op, input }` → `{ result }`, bounded to `SERVICE_MAX_BODY_BYTES` (1 MiB) per request

## Development

```bash
bun test           # 37+ tests across state/db/service/adapter/cli/daemon layers
bun x tsc --noEmit
```
