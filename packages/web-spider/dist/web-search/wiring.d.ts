import type { EngineUsage, IAnswerSearchEngine, ISearchEngine, SiteAvailabilityTracker } from "../ports.js";
import { type EngineFailureReason } from "./composites/index.js";
export interface DefaultSearchEngineOptions {
    /** Reads provider API keys from here. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Applied to keyed engines and the keyless fallback's circuit breaker. See FallbackSearchEngineOptions.cooldownMs. */
    cooldownMs?: number;
    /** Applied to keyed engines and the keyless fallback's circuit breaker. See FallbackSearchEngineOptions.quotaCooldownMs. */
    quotaCooldownMs?: number;
    /** Reports every engine failure by its real name, including the last-resort "firecrawl" Strategy. */
    onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
    /** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
    onUsage?: (engineName: string, usage: EngineUsage) => void;
    /** Tracks per-site engine coverage for site-filtered queries. Defaults to a fresh InMemorySiteAvailabilityTracker (process-lifetime only); inject a persistent implementation for cross-restart memory. See {@link SiteRoutedSearchEngine}. */
    siteAvailabilityTracker?: SiteAvailabilityTracker;
    /** Last-resort keyless Strategy. Defaults to Firecrawl; injectable for deterministic tests. */
    keylessEngine?: ISearchEngine;
}
/**
 * Build a search chain from environment variables: every keyed engine
 * (brave/tavily/exa/serper/serpapi/you) that actually has an API key
 * configured is round-robined as an equal-tier peer -- spreading quota
 * consumption across whichever are available instead of always hitting
 * one first. An engine with no key configured is auto-skipped. Firecrawl's
 * officially supported keyless endpoint is the bounded last resort, and is
 * used directly when no provider keys are configured.
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
 * Keyed site/capability routing is wrapped with the keyless Strategy only at
 * the outer boundary. The outer chain has no cooldown of its own, so one keyed
 * peer never cools down the whole group; each keyed peer and the keyless
 * adapter retain independent circuit-breaker state. If a keyed provider throws
 * and keyless is empty or blocked, the earlier actionable provider error is
 * preserved rather than converted to an empty-success result.
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