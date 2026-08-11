# Per-site content source strategies (the extension point)

Web Spider ships a second Strategy boundary alongside `ContentExtractor`
(`docs/content-extractors.md`): `ContentSourceStrategy`
(`packages/web-spider/src/sources/content-source.ts`). This is the seam for
"this specific site has a real API/data endpoint — use that instead of
scraping its rendered page," and it is the intended place to add support for
a new unique or complex (SPA) site without editing `spider()` itself.

## Why this is a separate port from `ContentExtractor`

`ContentExtractor` is pure: it converts an already-fetched `FetchedResource`
and performs no I/O (`docs/content-extractors.md`). A per-site strategy is
not pure — knowing whether `github.com/x/y` is a real repo, or whether an
origin actually runs MediaWiki, requires a network probe. `ContentSourceStrategy`
is therefore *the fetch itself*: it decides whether a URL is its shape, does
whatever network work is needed to resolve a better resource, and hands back
a plain `{ url, contentType, text, title? }` for the normal extraction
pipeline to run on — exactly as if that text had come from a plain `GET`.

```ts
interface ContentSourceStrategy {
  readonly name: string;                 // surfaced as page.viaStrategy on a hit
  matches(url: string): boolean;         // cheap, synchronous, no network
  fetch(req: ContentSourceRequest): Promise<ContentSourceResult | null>;
}
```

`matches()` is checked first and must be cheap — a URL-shape check only.
`fetch()` is only ever called once `matches()` already said yes, and must
return `null` (never throw) for any real miss: wrong platform, API error,
rate limit, empty content. A miss falls through to the next strategy, then
to a plain fetch — the same "ordered list, first hit wins, fail open" shape
`ContentExtractor` and the crawl Strategies (`docs/crawl-strategies.md`)
already established.

## Built-in strategies

| name              | module                          | what it does |
|-------------------|----------------------------------|---------------|
| `llms-txt`        | `sources/llms-txt.ts`            | Probes the URL's origin for a published `llms.txt` content index. |
| `markdown-suffix` | `sources/markdown-suffix.ts`     | Probes a `.md` sibling of the exact requested URL (verified real on AWS docs). |
| `github`          | `sources/github.ts`              | Queries GitHub's REST API for repo/issue/PR data instead of scraping the JS-heavy rendered page. |
| `mediawiki`       | `sources/mediawiki.ts`           | Queries a MediaWiki site's own `action=parse` API (Wikipedia, Wiktionary, ArchWiki, Fandom, ...) for clean article HTML. |
| `youtube`         | `sources/youtube.ts`             | Queries YouTube's official, keyless oEmbed endpoint for a video's title/author/thumbnail — no headless browser needed for that part. |

Each module exports both its original probe function(s) (`queryGitHub`,
`detectMediaWiki`, `probeLlmsTxt`, ...) *and* a `xContentSource(options?)`
factory returning a ready-made `ContentSourceStrategy` — the factory is a
thin adapter over the same logic `spider()`'s legacy `preferLlmsTxt` /
`preferMarkdownVariant` / `preferGitHub` / `preferMediaWiki` boolean options
still use internally. Those flags are unchanged and remain the simplest way
to turn on one specific built-in; `contentSources` (below) is the general
mechanism everything else is built on.

## Using it: `SpiderOptions.contentSources`

```ts
import { spider, githubContentSource, youtubeContentSource } from "@danypops/web-spider";

const page = await spider(url, {
  contentSources: [githubContentSource(), youtubeContentSource(), myOwnStrategy],
});
```

Strategies run in array order, before the legacy `preferX` flags, before the
normal fetch+Readability path. The first one whose `matches(url)` is true
*and* whose `fetch()` returns non-null wins; everything else is untouched.
`page.viaStrategy` reports which one fired (or is absent for a plain fetch).

## Adding a new site — the extension recipe

1. Create `src/sources/my-site.ts`. Write `matches(url)` as a narrow,
   synchronous URL-shape check (see `parseGitHubUrl`, `extractWikiPageTitle`,
   `parseYouTubeVideoId` for the pattern) — false positives cost a wasted
   network probe, not correctness, but a tight check keeps that cost near
   zero for every other URL.
2. Write `fetch()` against a **real, verified** endpoint — an official API,
   a documented oEmbed/JSON-LD/sitemap convention, or a site-specific
   `.md`/`.json` sibling — never a guessed private endpoint. Return `null`
   (never throw) for anything that isn't a genuine hit.
3. Export a `mySiteContentSource(options?)` factory returning a
   `ContentSourceStrategy` built from those two functions.
4. Either pass an instance directly via `contentSources: [mySiteContentSource()]`,
   or register it globally for name-based resolution:

   ```ts
   import { registerContentSource } from "@danypops/web-spider";
   registerContentSource("my-site", () => mySiteContentSource());
   ```

   `listRegisteredContentSources()` / `resolveContentSources(names)` /
   `buildRegisteredContentSources()` (`src/sources/registry.ts`) mirror the
   web-search engine registry's `registerSearchEngine` shape exactly —
   adding a site is one call, never an edit to `spider()`, `registry.ts`'s
   seed block, or any other existing strategy.

## Where this stops, and where `enhanced` (headless) takes over

A `ContentSourceStrategy` only ever wraps a **real, stable, keyless-or-
cheaply-keyed data endpoint**. It is deliberately not a general scraping
framework: it cannot click through a login wall, wait out a client-side
render, or drive a `<video>` player. That is what `enhanced: true`
(`PlaywrightHttpClient`, see the daemon's `web_fetch(enhanced=true)`) is for
— a real headless browser, auto-triggered by the daemon when a plain fetch
comes back JS-rendered.

The `youtube` strategy is the deliberate example of the boundary: it solves
"what is this video" via oEmbed without a browser, but does not attempt a
transcript or description (no public keyless endpoint exists for those) —
that remains `enhanced: true` territory, or a future, more elaborate
strategy that manages its own YouTube Data API key. Prefer finding the real
API first; reach for a headless browser only for the part that genuinely
has no API.

## Deliberate limits

Same restraint as `ContentExtractor` and the web-search composites: this is
an ordered Strategy list plus a name registry, not an abstract base class,
service locator, or generic plugin-discovery framework (no filesystem
scanning of a plugins directory, no dynamic `import()` of arbitrary
third-party code). A strategy is just a plain object implementing two
methods; wiring one in is an explicit array entry or an explicit
`registerContentSource()` call, always visible at the call site.
