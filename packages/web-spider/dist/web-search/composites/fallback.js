import { isLikelyQuotaExceededError, isLikelyRateLimitError } from "./errors.js";
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
export class FallbackSearchEngine {
    constructor(engines, opts = {}) {
        this.engines = engines;
        if (engines.length === 0)
            throw new Error("FallbackSearchEngine requires at least one engine");
        this.fallbackOnEmpty = opts.fallbackOnEmpty ?? true;
        this.fallbackOnError = opts.fallbackOnError ?? true;
        this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
        this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
        this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
        this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
        this.now = opts.now ?? Date.now;
        this.onEngineFailure = opts.onEngineFailure;
        this.cooldownUntil = engines.map(() => 0);
    }
    async search(req) {
        let lastError;
        // Gates the final throw below: a later engine completing with zero hits
        // is a real empty result, never masked by an earlier engine's error.
        let anySucceeded = false;
        for (let i = 0; i < this.engines.length; i++) {
            if (this.cooldownUntil[i] > this.now()) {
                const cooldownError = new Error(`engine ${i} skipped: in cooldown after a recent rate-limit/quota error`);
                lastError = cooldownError;
                this.onEngineFailure?.(i, cooldownError, "cooldown");
                continue;
            }
            try {
                const results = await this.engines[i].search(req);
                anySucceeded = true;
                if (results.length > 0 || !this.fallbackOnEmpty)
                    return results;
                // Empty + fallbackOnEmpty → try next engine
            }
            catch (err) {
                if (!this.fallbackOnError)
                    throw err;
                lastError = err;
                if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
                    this.cooldownUntil[i] = this.now() + this.quotaCooldownMs;
                    this.onEngineFailure?.(i, err, "quota");
                }
                else {
                    if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
                        this.cooldownUntil[i] = this.now() + this.cooldownMs;
                    }
                    this.onEngineFailure?.(i, err, "error");
                }
                // Error + fallbackOnError → try next engine
            }
        }
        if (!anySucceeded && lastError)
            throw lastError;
        return [];
    }
}
//# sourceMappingURL=fallback.js.map