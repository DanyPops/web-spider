# @danypops/web-spider

AI-agent-friendly web spider: structured output, RAG-ready chunks, graph-traversable links. The underlying library behind [`@danypops/pi-web-spider`](https://www.npmjs.com/package/@danypops/pi-web-spider) and [`@danypops/web-spider-daemon`](https://www.npmjs.com/package/@danypops/web-spider-daemon) — most users want one of those instead of depending on this directly.

## What's in here

- `spider`/`crawl` — fetch and BFS-crawl a site, robots.txt-respecting and per-domain throttled, with pluggable `IHttpClient`/`ICache`/`IThrottle`/`IRobotsChecker` ports.
- Output as clean markdown, a lean outline, a link list, BM25F highlights, or a semantic DOM tree.
- `webSearch` — one function across seven search providers (Brave, Brave LLM Context, Tavily, Exa, Serper, SerpApi, You.com), with round-robin quota spreading, rate-limit/quota-aware cooldown and fallback, and per-site engine-coverage routing.
- Well-known site strategies: GitHub (REST/GraphQL), MediaWiki (Wikipedia and any MediaWiki wiki), `llms.txt`, `.md`-suffix docs.
- `SpiderCache`, `PageGraph`, `DomainThrottle`, `RobotsCache` — the concrete adapters behind the ports above, usable standalone.

## Install

```bash
npm install @danypops/web-spider
```

## Repository

Part of the [web-spider monorepo](https://github.com/DanyPops/web-spider) — see its README for the full daemon/extension architecture.
