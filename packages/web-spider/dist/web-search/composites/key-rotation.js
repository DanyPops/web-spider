import { isLikelyRateLimitError } from "./errors.js";
/** Hound's own defaults: a rate-limited key clears in 60s (a request-rate throttle that resolves on its own); an invalid key (401/403) waits 300s -- long enough that a key which is only *temporarily* misconfigured (e.g. a provider-side propagation delay after rotating a secret) isn't retried on every single call, while still eventually giving it another chance rather than disabling it forever in this process's lifetime. */
export function createDefaultKeyCooldownPolicy() {
    return {
        cooldownMs: (kind) => (kind === "rate-limited" ? 60_000 : 300_000),
    };
}
/** True for a 401/403-shaped "this specific credential is bad" response -- distinct from {@link isLikelyRateLimitError} (a request-rate throttle that clears on its own) and {@link import("./errors.js").isLikelyQuotaExceededError} (an account-level quota, not a bad credential). Retrying the *same* key after this is pointless; a *different* key for the same provider might still work, which is exactly what {@link RotatingKeySearchEngine} does with it. */
export function isLikelyInvalidKeyError(error) {
    if (!(error instanceof Error))
        return false;
    if (/\b(401|403)\b/.test(error.message))
        return true;
    return /invalid[\s_-]?api[\s_-]?key|invalid key|unauthorized|forbidden/i.test(error.message);
}
/**
 * BYOK key stacking for a *single* search provider: cycles through several
 * API keys for the same provider before ever surfacing a failure to an
 * outer, provider-level composite (FallbackSearchEngine/RoundRobinSearchEngine).
 * A rate-limited or invalid-key failure only cools down that one key, not
 * the whole provider -- "fall back to a different provider" only happens
 * once every key for *this* provider is exhausted, matching Hound's own
 * per-key rotation/cooldown behavior. A genuine non-key-shaped error (a
 * network failure, a 5xx) is rethrown immediately without cycling through
 * every remaining key -- that's a provider-level problem, not a bad key,
 * and the outer composite is the right place to decide what to do about it.
 *
 * In-memory only, like {@link import("./fallback.js").FallbackSearchEngine}'s own
 * cooldown state -- resets on process restart by design (see Hound's own
 * choice, matched deliberately rather than adding persisted rotation state
 * for a problem this small).
 */
export class RotatingKeySearchEngine {
    constructor(keys, buildEngine, opts = {}) {
        this.keys = keys;
        this.buildEngine = buildEngine;
        if (keys.length === 0)
            throw new Error("RotatingKeySearchEngine requires at least one key");
        this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
        this.isInvalidKeyError = opts.isInvalidKeyError ?? isLikelyInvalidKeyError;
        this.cooldownPolicy = opts.cooldownPolicy ?? createDefaultKeyCooldownPolicy();
        this.now = opts.now ?? Date.now;
        this.onKeyFailure = opts.onKeyFailure;
        this.cooldownUntil = keys.map(() => 0);
    }
    async search(req) {
        let lastError;
        for (let i = 0; i < this.keys.length; i++) {
            if (this.cooldownUntil[i] > this.now()) {
                lastError ??= new Error(`key ${i} skipped: in cooldown after a recent rate-limit/invalid-key failure`);
                continue;
            }
            try {
                return await this.buildEngine(this.keys[i]).search(req);
            }
            catch (err) {
                if (this.isInvalidKeyError(err)) {
                    this.cooldownUntil[i] = this.now() + this.cooldownPolicy.cooldownMs("invalid");
                    this.onKeyFailure?.(i, err, "invalid");
                    lastError = err;
                }
                else if (this.isRateLimitError(err)) {
                    this.cooldownUntil[i] = this.now() + this.cooldownPolicy.cooldownMs("rate-limited");
                    this.onKeyFailure?.(i, err, "rate-limited");
                    lastError = err;
                }
                else {
                    // Not a key problem -- a different key for this same provider won't
                    // help. Let the outer, provider-level composite decide what to do.
                    throw err;
                }
            }
        }
        // Every key is either in cooldown or was just marked invalid/rate-limited.
        throw lastError ?? new Error("RotatingKeySearchEngine: no keys configured");
    }
}
//# sourceMappingURL=key-rotation.js.map