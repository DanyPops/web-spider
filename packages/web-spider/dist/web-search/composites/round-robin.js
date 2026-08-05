import { isLikelyQuotaExceededError, isLikelyRateLimitError } from "./errors.js";
/**
 * A composite ISearchEngine that spreads calls evenly across equal-tier
 * engines instead of always hitting the first one -- unlike
 * FallbackSearchEngine's fixed priority order (best engine first, worse
 * ones as fallback), round-robin treats every engine as an interchangeable
 * peer and cycles through them one call at a time.
 *
 * Tracks cooldown per engine (not per composite), so nesting this inside a
 * FallbackSearchEngine never lets one member's rate limit collapse the
 * whole group's fate -- the entire reason to round-robin quota-limited
 * peers is to keep their quotas independent. A cooling-down slot is
 * skipped in favor of the next available one; if every engine is cooling
 * down, the call throws.
 *
 * Does no fallback on a genuine call failure by itself -- the picked
 * engine's error propagates as-is rather than trying a sibling within the
 * same call. A caller that wants same-call fallback can still nest this
 * inside a FallbackSearchEngine with further entries (defaultSearchEngine's
 * own wiring doesn't, since it has no further keyless entry to offer).
 *
 * @example
 * // Spread load across three paid engines, Exa as a lower-priority fallback
 * const engine = new FallbackSearchEngine([
 *   new RoundRobinSearchEngine([tavily, serper, serpapi]),
 *   new ExaSearchEngine(exaKey),
 * ]);
 */
export class RoundRobinSearchEngine {
    constructor(engines, opts = {}) {
        this.engines = engines;
        this.cursor = 0;
        if (engines.length === 0)
            throw new Error("RoundRobinSearchEngine requires at least one engine");
        this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
        this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
        this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
        this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
        this.now = opts.now ?? Date.now;
        this.onEngineFailure = opts.onEngineFailure;
        this.cooldownUntil = engines.map(() => 0);
    }
    async search(req) {
        const start = this.cursor;
        this.cursor = (start + 1) % this.engines.length;
        let index = -1;
        for (let attempt = 0; attempt < this.engines.length; attempt++) {
            const candidate = (start + attempt) % this.engines.length;
            if (this.cooldownUntil[candidate] > this.now()) {
                const cooldownError = new Error(`engine ${candidate} skipped: in cooldown after a recent rate-limit/quota error`);
                this.onEngineFailure?.(candidate, cooldownError, "cooldown");
                continue;
            }
            index = candidate;
            break;
        }
        if (index === -1)
            throw new Error("RoundRobinSearchEngine: every engine is currently in cooldown");
        try {
            return await this.engines[index].search(req);
        }
        catch (err) {
            if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
                this.cooldownUntil[index] = this.now() + this.quotaCooldownMs;
                this.onEngineFailure?.(index, err, "quota");
            }
            else {
                if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
                    this.cooldownUntil[index] = this.now() + this.cooldownMs;
                }
                this.onEngineFailure?.(index, err, "error");
            }
            throw err;
        }
    }
}
//# sourceMappingURL=round-robin.js.map