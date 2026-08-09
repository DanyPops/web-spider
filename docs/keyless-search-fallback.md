# Keyless search fallback assessment

Assessment date: 2026-08-09. Decision: **ship a bounded Firecrawl keyless adapter as the last-resort `ISearchEngine` Strategy**.

## Candidates

| Candidate | Maintenance and access | Operational / policy finding | Decision |
| --- | --- | --- | --- |
| Firecrawl `/v2/search` | Official hosted API and actively maintained MIT repository/SDK (`firecrawl/firecrawl`, inspected at `448ef4bf815d8df798d1a676f0303285e54cabdb`). | Firecrawl's official [keyless launch](https://www.firecrawl.dev/blog/firecrawl-keyless-launch), [agent onboarding](https://www.firecrawl.dev/agent-onboarding/SKILL.md), and terms explicitly support automated agents and keyless fallback use. Upstream's own `keyless.test.ts` states that raw API callers have no origin gate. Allowance is per-IP/per-network and rate/credit limited; `429` is expected and must remain an error. | **Ship.** Official structured JSON avoids SERP scraping/CAPTCHA markup and fits `ISearchEngine`. |
| DuckDuckGo HTML / `duck-duck-scrape` | `duck-duck-scrape` currently publishes `2.2.7`, but parses an undocumented SERP. | Main-origin `robots.txt` disallows `/html`, `/lite`, and query result pages. The separate HTML host currently allows crawling, but there is no official stable search-results API contract and CAPTCHA/markup drift remains inherent. | No-go. |
| Public SearXNG instances | SearXNG itself is maintained and has a documented JSON API. | Official docs warn that many public instances disable JSON (403); public instances enable bot detection/rate limiting, are operated by unknown parties, and have a higher chance of upstream blocking/inaccurate results. Self-hosting is viable but is configuration, not zero-configuration fallback. | No-go as an implicit public-instance fallback. |
| Mojeek | Maintained official web index/API. | Official quickstart requires an active account and API key. | Not keyless. |

## Live quality and limit evidence

A direct unauthenticated `POST https://api.firecrawl.dev/v2/search` with `limit: 3`, web-only sources, and descriptions (no page scraping) returned HTTP 200, structured JSON, and three relevant results for `TypeScript dependency injection` (Reddit discussion, Microsoft's `tsyringe`, and a technical article). The call reported two credits. Firecrawl documents search cost as two credits per up-to-ten results and keyless access as a rate-limited fallback; it may return `429` with retry/quota information. No CAPTCHA or HTML parser is involved.

## Design

`FirecrawlKeylessSearchEngine` implements the existing structural `ISearchEngine` Strategy and injects a minimal Fetch-shaped transport for deterministic tests. It sends no Authorization header, requests only ordinary web results, disables highlights/full scraping, bounds the timeout, rejects redirects and malformed/error payloads, and normalizes only HTTP(S) result URLs. `siteFilter` and supported time windows map to Firecrawl's documented query/tbs surface; unsupported topic/full-content wants remain best-effort and do not expand credit use.

The adapter is the last resort after configured keyed providers. A general fallback option preserves an earlier actionable provider error when the last-resort backend is empty or blocked, preventing the removed Instant Answer failure mode from returning false empty-success. With no configured key, Firecrawl is used directly. Existing cooldown composition handles `429`; no provider-specific base class, service branch, or new search port is introduced.
