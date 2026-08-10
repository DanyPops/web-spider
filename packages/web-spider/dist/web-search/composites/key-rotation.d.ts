import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { type RateLimitPredicate } from "./errors.js";
/** Why a specific key (not the whole provider) was pulled out of rotation. Distinct from {@link import("./errors.js").EngineFailureReason} -- this classifies a single credential's failure, not a whole provider's. */
export type KeyFailureKind = "rate-limited" | "invalid";
/** Cooldown duration policy per {@link KeyFailureKind} -- a separate injectable Strategy rather than baked into RotatingKeySearchEngine itself, so the 60s/300s durations (or any override) are independently testable and swappable without touching rotation/bookkeeping logic (SRP/OCP). */
export interface KeyCooldownPolicy {
    cooldownMs(kind: KeyFailureKind): number;
}
/** Hound's own defaults: a rate-limited key clears in 60s (a request-rate throttle that resolves on its own); an invalid key (401/403) waits 300s -- long enough that a key which is only *temporarily* misconfigured (e.g. a provider-side propagation delay after rotating a secret) isn't retried on every single call, while still eventually giving it another chance rather than disabling it forever in this process's lifetime. */
export declare function createDefaultKeyCooldownPolicy(): KeyCooldownPolicy;
/** True for a 401/403-shaped "this specific credential is bad" response -- distinct from {@link isLikelyRateLimitError} (a request-rate throttle that clears on its own) and {@link import("./errors.js").isLikelyQuotaExceededError} (an account-level quota, not a bad credential). Retrying the *same* key after this is pointless; a *different* key for the same provider might still work, which is exactly what {@link RotatingKeySearchEngine} does with it. */
export declare function isLikelyInvalidKeyError(error: unknown): boolean;
export interface RotatingKeySearchEngineOptions {
    /** Defaults to isLikelyRateLimitError. Checked before isInvalidKeyError, mirroring FallbackSearchEngine's own quota-before-rate-limit precedence order. */
    isRateLimitError?: RateLimitPredicate;
    /** Defaults to isLikelyInvalidKeyError. */
    isInvalidKeyError?: RateLimitPredicate;
    /** Defaults to createDefaultKeyCooldownPolicy() (60s rate-limited / 300s invalid). */
    cooldownPolicy?: KeyCooldownPolicy;
    /** Clock, injectable for tests. Defaults to Date.now. */
    now?: () => number;
    /** Called once per key failure that triggers a cooldown -- never for a genuine non-key-shaped error, which is rethrown immediately instead of attributed to any one key. Index only, not the raw key value -- a raw API key must never reach a log line. */
    onKeyFailure?: (keyIndex: number, error: unknown, kind: KeyFailureKind) => void;
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
export declare class RotatingKeySearchEngine implements ISearchEngine {
    private readonly keys;
    private readonly buildEngine;
    private readonly isRateLimitError;
    private readonly isInvalidKeyError;
    private readonly cooldownPolicy;
    private readonly now;
    private readonly onKeyFailure;
    /** keys[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
    private readonly cooldownUntil;
    constructor(keys: string[], buildEngine: (key: string) => ISearchEngine, opts?: RotatingKeySearchEngineOptions);
    search(req: SearchQuery): Promise<WebSearchResult[]>;
}
//# sourceMappingURL=key-rotation.d.ts.map