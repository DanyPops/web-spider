# Response content extractors

Web Spider separates transport orchestration from response-content conversion with a small Strategy boundary.

## Contract and dependency direction

`spider()` owns URL validation, robots checks, throttling, HTTP retries, strategy probes, and optional image hydration. After a response is fetched, it passes a bounded `FetchedResource` and `ContentExtractionOptions` to an ordered `ContentExtractor` list. An extractor only decides whether it supports that resource and converts it to Web Spider's normalized page model; it does not fetch URLs, read caches, check robots rules, or depend on daemon, Vehicle, SQLite, Playwright, or Pi types.

The core orchestration depends on the structural `ContentExtractor` interface. Built-in HTML and textual extractors implement it. Callers can prepend a narrow fake or media-specific adapter through `SpiderOptions.contentExtractors`; the first extractor whose `supports()` method returns `true` is selected, followed by the built-ins. This makes a future PDF adapter possible without adding another media-type branch to `spider()`.

Extractors may return bounded asset candidates, such as image URLs found in article HTML. The orchestration layer remains responsible for any network hydration of those assets.

## Deliberate limits

This is an ordered Strategy list, not an abstract class, service locator, generic plugin framework, or parser repository. Selection remains an explicit first-match rule. Filesystem and transport repository abstractions were rejected because extractors do not perform I/O and `IHttpClient` plus temporary paths already cover existing test seams.
