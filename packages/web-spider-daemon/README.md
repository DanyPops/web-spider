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
| `cache.list` | Paginated, `grep`-filterable listing of cached pages (bounded: limit ≤ 100) |
| `cache.search` | BM25F search across cached pages (full chunk text, not a truncated snippet) |
| `search` | Live web search via Brave/Tavily/Exa/DDG, provider fallback chain, `numResults`/`timeRange`/`topic`/`searchEngine` |
| `fetch` | Single-page fetch — `markdown`/`lean`/`links`/`highlights`/`tree` formats, `rootSelector`/`excludeSelectors`/`tokenBudget`, `enhanced` (Playwright). Robots-blocked pages return `{ blocked: true, reason: "robots.txt" }` instead of throwing. |
| `crawl` | Depth-bounded BFS crawl — `depth` (≤ 5), `maxPages` (≤ 200), `sameDomain`, same formats as `fetch` plus a crawl summary. Bounds are enforced server-side regardless of what a caller requests. |
| `papyrus.ingest` | Explicit opt-in: turns already-cached pages (`kind: "pages"`, by URL) or a caller-supplied search-result set (`kind: "search"`) into Papyrus `doc` artifacts (`subtype: "web"` / `"web-search-result"`), optionally linked to an existing artifact via `relatesTo`. Bounded to 20 items per call. Ingested Docs are immutable service output — never updated in place; re-ingesting the same URL creates a new Doc. Reaches Papyrus only through its own authenticated client, never its SQLite file directly. |

Provider API keys (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`) and `WEB_SPIDER_PLAYWRIGHT_EXECUTABLE` are read once from the **daemon's own environment** — set them in the systemd unit's `Environment=` lines, never pass them through an operation input. DDG requires no key and is always the zero-cost fallback. Throttling (500ms per-domain minimum) and robots.txt checking use daemon-process-wide singletons, replacing the pi-extension's previous per-session instances.

`tree.query`/`tree.path` as standalone operations (today folded into `fetch(format: "tree")`), `robots.status`, `throttle.status`, `searchEnrich` composition, and `papyrus.ingest` land in follow-up tasks — see the design doc `web-spider-daemon-architecture-and-papyrus-integration-contr-5s14` for the full contract before they're implemented.

## CLI

Every registered operation has a CLI route using the authenticated client only — the CLI never opens SQLite directly. Human-readable output by default; `--json` prints the exact operation result for scripting.

```bash
web-spider fetch <url> [--format markdown|lean|links|highlights|tree] [--depth N] [--max-pages N]
                        [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]
                        [--token-budget N] [--enhanced] [--timeout-ms N] [--query TEXT] [--path DOTPATH]
                        [--top-n N] [--json]
web-spider search <query> [--num-results N] [--time-range day|week|month|year] [--topic news|general]
                        [--engine brave|tavily|exa|ddg] [--json]
web-spider cache list [--grep TEXT] [--offset N] [--limit N] [--json]
web-spider cache search <query> [--limit N] [--json]
web-spider papyrus ingest <url...> [--relates-to ARTIFACT_ID] [--json]
```

`papyrus ingest` requires each URL to already be cached (`web-spider fetch <url>` first) and requires a running, authenticated Papyrus daemon — it fails closed with Papyrus's own actionable "daemon is not running" message when Papyrus isn't installed or started. It is never automatic: nothing is pushed to Papyrus except in direct response to this explicit call.

`fetch` and `crawl` share one command: `--depth N` (N > 0) routes to the `crawl` operation, matching the `web_fetch` tool's own single-entry-point shape. Bounds (`depth` ≤ 5, `maxPages` ≤ 200, etc.) are enforced by the daemon regardless of what the CLI requests.

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
