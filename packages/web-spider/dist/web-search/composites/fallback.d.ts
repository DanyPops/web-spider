import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { type EngineFailureReason, type RateLimitPredicate } from "./errors.js";
export interface FallbackSearchEngineOptions {
    /**
     * Treat an empty result set as a failure and try the next engine.
     * Default: true.
     */
    fallbackOnEmpty?: boolean;
    /**
     * Swallow a thrown error and try the next engine instead of propagating.
     * Default: true.
     */
    fallbackOnError?: boolean;
    /** How long (ms) to skip an engine after a rate-limit-shaped failure. Default 10 minutes. 0 disables this cooldown tier. */
    cooldownMs?: number;
    /** How long (ms) to skip an engine after a quota-exhaustion-shaped failure (see {@link isLikelyQuotaExceededError}) -- much longer than a rate-limit cooldown, since retrying before the quota window resets just re-fails and wastes a call. Default 6 hours. 0 disables this cooldown tier (falls through to the rate-limit tier's classification instead). */
    quotaCooldownMs?: number;
    /** Defaults to isLikelyRateLimitError. */
    isRateLimitError?: RateLimitPredicate;
    /** Defaults to isLikelyQuotaExceededError. Checked before isRateLimitError, so a quota-shaped error gets the longer cooldown even if it would also match the rate-limit heuristic. */
    isQuotaError?: RateLimitPredicate;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
    /** Called once per engine failure, including a cooldown skip -- e.g. wire to a logger. Not called for a genuine empty result. Index only, not a name -- a caller that wants names maps it itself. */
    onEngineFailure?: (engineIndex: number, error: unknown, reason: EngineFailureReason) => void;
    /**
     * When every later fallback is empty or also fails, rethrow the earliest
     * actionable error instead of letting a last-resort empty/error mask it.
     * Default false preserves the historical generic fallback behavior.
     */
    preserveEarlierError?: boolean;
}
/**
 * A composite ISearchEngine that tries each engine in order, falling back
 * to the next when the current one returns empty results or throws, and
 * skipping an engine for a cooldown window after a rate-limit-shaped
 * failure rather than retrying an already-exhausted quota on every call.
 *
 * Because it implements ISearchEngine itself it is fully composable —
 * nest FallbackSearchEngines, wrap them in caches, inject stubs in tests.
 *
 * @example
 * // Tavily with Exa as a second-choice fallback
 * const engine = new FallbackSearchEngine([
 *   new TavilySearchEngine(process.env.TAVILY_API_KEY),
 *   new ExaSearchEngine(process.env.EXA_API_KEY),
 * ]);
 */
export declare class FallbackSearchEngine implements ISearchEngine {
    private readonly engines;
    private readonly fallbackOnEmpty;
    private readonly fallbackOnError;
    private readonly cooldownMs;
    private readonly quotaCooldownMs;
    private readonly isRateLimitError;
    private readonly isQuotaError;
    private readonly now;
    private readonly onEngineFailure;
    private readonly preserveEarlierError;
    /** engines[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
    private readonly cooldownUntil;
    constructor(engines: ISearchEngine[], opts?: FallbackSearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=fallback.d.ts.map