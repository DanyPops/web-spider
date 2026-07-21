# Web Spider

Search, fetch, and crawl the web for Pi — a supervised daemon owns the SQLite page cache, fetch/crawl/search execution, and (opt-in) Papyrus ingestion; the Pi extension is a thin authenticated client that renders results.

## Architecture

```text
Pi web_fetch tool
      ↓
Pi extension (thin client — no fetching/caching/throttling of its own)
      ↓
authenticated loopback daemon client → web-spider-daemon
      ↓
operation registry (cache.list/search, fetch, crawl, search, session.*, papyrus.ingest)
      ↓
SQLite (WAL) cache · IHttpClient/PlaywrightHttpClient · web search providers · Papyrus client
```

The daemon (`packages/web-spider-daemon`, `@danypops/web-spider-daemon`) is the sole owner of the page cache and the sole process that performs network fetches, crawls, throttling, and robots.txt checks. The Pi extension (`packages/pi-extension`, `@danypops/pi-web-spider`) never touches the network or a cache file directly — it only reconstructs the exact historical `web_fetch` tool contract on top of the daemon's operation responses. `packages/web-spider` is the underlying library (spider/crawl/search primitives, ports) both the daemon and, for now, a few standalone scripts depend on directly.

Every daemon operation has full CLI parity — see `packages/web-spider-daemon/README.md` for the complete operation/CLI reference, systemd service install, and health/readiness endpoints.

## Storage and service

```text
$XDG_DATA_HOME/web-spider/web-spider.db    # durable page cache + session audit journal (SQLite, WAL)
$XDG_STATE_HOME/web-spider/auth-token      # bearer token, 0600
$XDG_RUNTIME_DIR/web-spider/daemon.json    # private daemon discovery (host/port/pid)
$XDG_CONFIG_HOME/systemd/user/web-spider.service
```

```bash
web-spider service install   # install, enable, and start the user service
web-spider service status
web-spider service restart

web-spider fetch <url> [--format markdown|lean|links|highlights|tree] [--depth N] [--json]
web-spider search <query> [--json]
web-spider cache list [--grep TEXT] [--json]
web-spider cache search <query> [--json]
web-spider papyrus ingest <url...> [--relates-to ARTIFACT_ID] [--json]
web-spider session create|list|close|act <name> ...
```

The extension auto-starts the daemon transparently on first use — `service install` is only needed for it to survive across reboots/logins, or to forward search-provider API keys into a systemd `--user` unit (a unit does not inherit the installing shell's environment).

## Upgrading from the pre-daemon library

Earlier versions ran entirely in-process inside the Pi extension, caching pages to a plain JSON file at `~/.cache/web-spider/pages.json`. On first daemon startup, that file (if present) is imported once into the daemon's SQLite cache, then renamed to `pages.json.migrated` — nothing is lost, and the import never runs again once the cache is non-empty. No `pi` extension configuration changes are needed; `web_fetch`'s tool contract (parameters, output shapes) is unchanged by this migration, by design — see `docs/web-fetch-api.md`.

## Documentation

- [`docs/web-fetch-api.md`](docs/web-fetch-api.md) — the `web_fetch` tool's full parameter/output reference (consumer-facing contract).
- [`packages/web-spider-daemon/README.md`](packages/web-spider-daemon/README.md) — daemon architecture, every operation, full CLI reference, service install, health endpoints.

## Development

```bash
npm install
npm run check   # tsc --noEmit (+ biome lint where configured) across every package
npm test        # bun test across every package
```
