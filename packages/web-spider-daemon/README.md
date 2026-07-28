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

## Storage and service

```text
$XDG_DATA_HOME/web-spider/web-spider.db      # SQLite WAL, daemon-owned
$XDG_STATE_HOME/web-spider/auth-token        # 0600, 64 hex chars
$XDG_RUNTIME_DIR/web-spider/daemon.json      # 0600, { host, port, pid }
$XDG_CONFIG_HOME/systemd/user/web-spider.service
```

## Install

```bash
bun install
bun src/cli.ts service install   # renders + enables + starts the systemd --user unit
bun src/cli.ts service status
bun src/cli.ts service restart
bun src/cli.ts service stop
```

The unit runs `bun <cli.ts> serve` with `Restart=always`, `RestartSec=2`, `NoNewPrivileges=true`, `PrivateTmp=true` — it restarts automatically on failure and does not require root.

Run without installing a service (foreground, for development):

```bash
bun src/cli.ts serve
```

## Upgrade

Reinstalling the service (`service install`) re-renders the unit against the currently installed `bun`/`cli.ts` paths and restarts the daemon; the SQLite database and auth token are untouched by an upgrade. A newer package version that bumps the internal SQLite schema version applies its migration automatically on the next `serve` startup — schema migrations here are forward-only and versioned via `PRAGMA user_version`, matching Papyrus/Jittor.

## Uninstall

```bash
bun src/cli.ts service stop
systemctl --user disable web-spider.service
rm ~/.config/systemd/user/web-spider.service
systemctl --user daemon-reload
```

Removing the unit does not delete the SQLite database, auth token, or daemon handle files (`$XDG_DATA_HOME/web-spider`, `$XDG_STATE_HOME/web-spider`, `$XDG_RUNTIME_DIR/web-spider`) — delete those directories directly if a full reset is wanted.

## Operations

The current operation registry (see `src/service.ts`):

| Operation | Description |
|---|---|
| `cache.list` | Paginated listing of cached pages (bounded: limit ≤ 100), filterable by `grep` (substring), `domain` (exact), `tag` (auto-extracted), `category` (curated, see below), and `fetchedAfter`/`fetchedBefore`/`publishedAfter`/`publishedBefore` time ranges; sortable by `fetchedAt`/`publishedAt`/`url`/`domain` |
| `cache.search` | BM25F search across cached pages (full chunk text, not a truncated snippet) |
| `search` | Live web search via Brave/Tavily/Exa/Serper/SerpApi/You.com, provider fallback chain, `numResults`/`timeRange`/`topic`/`searchEngine`/`siteFilter`/`wantFullContent` -- the latter two are declarative ("restrict to this domain" / "give me full page content"), routed to whichever configured provider can satisfy them rather than naming one |
| `search.usage` | Per-call usage/cost data each engine itself reported (`credits` for Tavily, `costUsd` for Exa, `rateLimitHeaders` for Brave when present) -- append-only, bounded to the most recent 10,000 rows, filterable by `engine`. Never a running account balance: no provider's search API exposes one, only what one call cost. |
| `fetch` | Single-page fetch — `markdown`/`lean`/`links`/`highlights`/`tree` formats, `rootSelector`/`excludeSelectors`/`tokenBudget`, `enhanced` (Playwright). Robots-blocked pages return `{ blocked: true, reason: "robots.txt" }` instead of throwing. |
| `crawl` | Depth-bounded BFS crawl — `depth` (≤ 5), `maxPages` (≤ 200), `sameDomain`, same formats as `fetch` plus a crawl summary. Bounds are enforced server-side regardless of what a caller requests. |
| `papyrus.ingest` | Explicit opt-in: turns already-cached pages (`kind: "pages"`, by URL) or a caller-supplied search-result set (`kind: "search"`) into Papyrus `doc` artifacts (`subtype: "web"` / `"web-search-result"`), optionally linked to an existing artifact via `relatesTo`. Bounded to 20 items per call. Ingested Docs are immutable service output — never updated in place; re-ingesting the same URL creates a new Doc. Reaches Papyrus only through its own authenticated client, never its SQLite file directly. |
| `session.create` | Launches a named, isolated Playwright browser **process** (not a shared-browser context) — tmux-style session semantics. Bounded to 5 concurrent sessions; rejects past the ceiling rather than queuing. Defaults to Playwright's own lighter `chromium-headless-shell` in headless mode; `forceChromeChannel: true` opts into the full installed Chrome for headed-rendering-exact fidelity. |
| `session.list` | Lists active sessions with their `snapshotVersion` and activity timestamps. |
| `session.close` | Tears a named session's browser process down. |
| `session.act` | Dispatches one `navigate`/`click`/`eval`/`screenshot` action against a session's persistent page. Requires the caller's `snapshotVersion` to match the session's current one — fails closed (HTTP 409) if the page has navigated or changed since the caller last observed it, rather than silently acting on stale state. Only a successful `navigate` bumps `snapshotVersion`. Every call — successful, rejected, or failed — is recorded in an append-only, content-free audit journal (SQLite `session_audit_log`, bounded to the most recent 10,000 rows): action, outcome, and a redacted target (a sanitized URL for `navigate`, the selector for `click`, and a fixed `"<script>"`/`"<screenshot>"` placeholder for `eval`/`screenshot` — script source and image bytes are never written to the journal, only returned to the caller). |
| `category.assign` | Curated, agent/user-assignable relevance category for a cached page (distinct from `domain`/`tags` — a judgment about what a page is *for*, not mechanical metadata). Creates the category on first use; assigning twice is a no-op. A page can belong to any number of categories at once. |
| `category.remove` | Removes a category from a page. Idempotent — no error if already absent. |
| `category.rename` | Renames a category everywhere it's used in one step (categories have a real id, not free text per page). Renaming into an already-existing name merges the two rather than erroring. |
| `category.list` | Lists every known category with its page count. |

Provider API keys (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SERPER_API_KEY`, `SERPAPI_API_KEY`, `YOU_API_KEY`) and `WEB_SPIDER_PLAYWRIGHT_EXECUTABLE` are read once from the **daemon's own environment** — never passed through an operation input. Every configured keyed provider is round-robined as an equal-tier peer (spreading query volume so no single provider's quota gets hammered first), each with its own cooldown after a rate-limit-shaped failure. `search` throws a clear error when zero provider keys are configured, rather than returning an empty result. Throttling (500ms per-domain minimum) and robots.txt checking use daemon-process-wide singletons, replacing the pi-extension's previous per-session instances.

A systemd `--user` service does **not** inherit your login shell's environment. `service install` reads all five provider key vars from the shell that runs it and forwards any that are set into the unit's `Environment=` lines automatically — run `service install` from a shell that already has your key(s) exported, or add `Environment=` lines to the unit by hand afterward. Reinstalling (`service install` again) re-renders the unit and picks up updated keys. `WEB_SPIDER_PLAYWRIGHT_EXECUTABLE` is not auto-forwarded; set it in the unit directly if needed.

### Optional: a local, per-engine key file instead of an env var

`web-spider search-key set <engine>` stores an API key in its own small file under this daemon's state directory (`search-keys/<engine>.json`, 0600, plaintext), independent of the process environment entirely:

```bash
web-spider search-key set tavily       # hidden prompt, or WEB_SPIDER_SEARCH_KEY_VALUE=... for scripts
web-spider search-key list             # engine names only, never the keys themselves
web-spider search-key remove tavily
```

This exists because a systemd `--user` service's env is not actually scoped to what it needs — it inherits the whole desktop session's environment, secrets included. A locally stored key sidesteps that: it lives in a file only this daemon's own state directory holds, and it overrides a same-named env var rather than being overridden by it. Takes effect on the daemon's next restart (`resolveSearchEnv()` resolves once at startup, not per search call).

### Optional: credentials via Enigma, instead of a static key per provider

Enigma involvement is opt-in — set `WEB_SPIDER_USE_ENIGMA=1` explicitly. Without it, the daemon never probes for Enigma at all, even if one happens to be running on the machine for some other daemon's sake: being reachable isn't the same as being wanted.

With the flag set, the daemon asks Enigma at startup which provider backends it's registered for (`enigma client add`) and fills in each one's declared env var from the vault, ahead of whatever the daemon's own environment already has. Nothing is hardcoded — Enigma is the source of truth for both which backends this daemon has and which env var each one maps to (set once, at `enigma login apikey --env-var ...` time).

```bash
enigma login apikey --name Brave --env-var BRAVE_SEARCH_API_KEY
enigma client add web-spider --backends brave,tavily,exa
# -> prints a token once; export it wherever the daemon is started
export ENIGMA_CLIENT_TOKEN=<printed token>
export WEB_SPIDER_USE_ENIGMA=1
```

Without `ENIGMA_CLIENT_TOKEN`, Enigma's shared admin-token file is deliberately unreadable outside its own service account — the daemon falls straight through to its own environment's static keys, unchanged from before Enigma existed.

### The full ladder

Each engine resolves its key in this order, strongest wins:

1. Enigma, if `WEB_SPIDER_USE_ENIGMA=1` and a credential is registered
2. This daemon's own local key file (`search-key set`)
3. The raw process environment (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, ...)

Each rung is independently optional; using only the env var works identically to before either of the other two existed.

`tree.query`/`tree.path` as standalone operations (today folded into `fetch(format: "tree")`), `robots.status`, `throttle.status`, `searchEnrich` composition, and `papyrus.ingest` land in follow-up work.

## CLI

Every registered operation has a CLI route using the authenticated client only — the CLI never opens SQLite directly. Human-readable output by default; `--json` prints the exact operation result for scripting.

```bash
web-spider fetch <url> [--format markdown|lean|links|highlights|tree] [--depth N] [--max-pages N]
                        [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]
                        [--token-budget N] [--enhanced] [--timeout-ms N] [--query TEXT] [--path DOTPATH]
                        [--top-n N] [--json]
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
web-spider session create <name> [--force-chrome-channel] [--json]
web-spider session list [--json]
web-spider session close <name> [--json]
web-spider session act <name> --action navigate --snapshot-version N --url URL [--timeout-ms N] [--json]
web-spider session act <name> --action click --snapshot-version N --selector CSS [--timeout-ms N] [--json]
web-spider session act <name> --action eval --snapshot-version N [--script-file PATH] [--json]
web-spider session act <name> --action screenshot --snapshot-version N [--json]
```

`session act --action eval` never accepts the script as a plain flag value (shell history and `ps` would leak it) — it reads the script from `--script-file PATH`, or from stdin if that's omitted:

```bash
echo "document.title" | web-spider session act agent1 --action eval --snapshot-version 0
web-spider session act agent1 --action eval --snapshot-version 0 --script-file ./check.js
```

Every `session act` call needs the session's current `snapshotVersion` (from `session create`'s response or the previous `act` call's response) — an out-of-date version is rejected rather than silently acting against a page that may have already navigated elsewhere.

`papyrus ingest` requires each URL to already be cached (`web-spider fetch <url>` first) and requires a running, authenticated Papyrus daemon — it fails closed with Papyrus's own actionable "daemon is not running" message when Papyrus isn't installed or started. It is never automatic: nothing is pushed to Papyrus except in direct response to this explicit call.

`fetch` and `crawl` share one command: `--depth N` (N > 0) routes to the `crawl` operation, matching the `web_fetch` tool's own single-entry-point shape. Bounds (`depth` ≤ 5, `maxPages` ≤ 200, etc.) are enforced by the daemon regardless of what the CLI requests.

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
