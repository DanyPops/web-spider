import type { EngineUsage, IAnswerSearchEngine, ISearchEngine, SiteAvailabilityTracker } from "../ports.js";
import { type EngineFailureReason } from "./composites/index.js";
export interface DefaultSearchEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.cooldownMs. */
    cooldownMs?: number;
    /** Applied to both the round-robin group and the outer fallback chain. See FallbackSearchEngineOptions.quotaCooldownMs. */
    quotaCooldownMs?: number;
    /** Reports every engine failure by its real name ("brave"/"tavily"/"exa"/"serper"/"serpapi"/"you") -- never a generic placeholder, whether the failure came from the sole configured engine or one member of the round-robin group. */
    onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
    /** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
    /** Tracks per-site engine coverage for site-filtered queries. Defaults to a fresh InMemorySiteAvailabilityTracker (process-lifetime only); inject a persistent implementation for cross-restart memory. See {@link SiteRoutedSearchEngine}. */
    siteAvailabilityTracker?: SiteAvailabilityTracker;
}
/**
 * Build a search chain from environment variables: every keyed engine
 * (brave/tavily/exa/serper/serpapi/you) that actually has an API key
 * configured is round-robined as an equal-tier peer -- spreading quota
 * consumption across whichever are available instead of always hitting
 * one first. An engine with no key configured is auto-skipped, never
 * throws by itself; calling this with zero keys configured throws a
 * single descriptive error instead of silently returning a no-op engine.
 *
 * The whole chain is wrapped in {@link SiteRoutedSearchEngine}: a query
 * with no site filter passes straight through to the round-robin/fallback
 * chain described above, unchanged; a site-filtered query (or one
 * containing a literal `site:domain` operator) is instead routed by which
 * configured engines have actually returned matching results for that
 * site before, so a domain a given engine has no real coverage of (e.g.
 * Reddit, which blocked every crawler but Google-backed ones in 2024) is
 * learned once and skipped on later calls instead of re-paid every time.
 *
 * Returns the RoundRobinSearchEngine directly (before the SiteRoutedSearchEngine
 * wrap) when 2+ keys are configured -- no outer FallbackSearchEngine wrapper
 * for the unfiltered path. There's no keyless engine left to fall through to,
 * so a wrapper around a single entry (the round-robin group itself) would add
 * nothing but a duplicate, generically-named onEngineFailure report for a
 * failure the round-robin already reports by real engine name; its own
 * cooldown would also have to be force-disabled to avoid one member's
 * failure cooling down the whole group a second time.
 *
 * With exactly one keyed engine, wraps it in a single-entry
 * FallbackSearchEngine purely for the cooldown/quota-cooldown circuit
 * breaker -- without it, a provider already known to be quota-exhausted
 * would be hit again on every call instead of short-circuiting to a clear
 * "in cooldown" error.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export declare function defaultSearchEngine(opts?: DefaultSearchEngineOptions): ISearchEngine;
export interface DefaultAnswerEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Reports every successful call's own usage/cost data by real engine name. See {@link DefaultSearchEngineOptions.onUsage}. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
}
/**
 * Resolves an {@link IAnswerSearchEngine} from configured provider keys, by
 * capability rather than by name -- a caller never names "Tavily" to get an
 * answer; it declares the want (via {@link import("./index.js").webSearch}'s wantAnswer, or by
 * calling this directly) and whichever configured engine actually
 * implements searchForAnswer is used. Extending an existing ISearchEngine
 * adapter to also implement IAnswerSearchEngine (e.g. a future Serper/
 * SerpApi answerBox mapping) makes it eligible here with zero other
 * changes -- the whole point of routing by capability instead of name.
 *
 * Throws a distinct, more specific error than {@link defaultSearchEngine}'s
 * own when provider keys exist but none of the configured engines can
 * produce an answer -- "you have Brave configured" is a materially
 * different problem to fix than "you have nothing configured at all".
 */
export declare function defaultAnswerEngine(opts?: DefaultAnswerEngineOptions): IAnswerSearchEngine;
/** Resolves a single named engine and asserts it supports wantAnswer, for webSearch's forced-engine path. Throws a clear, actionable error naming the engine rather than a generic type error when it doesn't. */
export declare function resolveAnswerEngine(name: string, key: string | undefined): IAnswerSearchEngine;
//# sourceMappingURL=wiring.d.ts.map