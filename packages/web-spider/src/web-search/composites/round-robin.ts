import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { type EngineFailureReason, isLikelyQuotaExceededError, isLikelyRateLimitError, type RateLimitPredicate } from "./errors.js";

export interface RoundRobinSearchEngineOptions {
	/** How long (ms) to skip an engine's rotation slot after a rate-limit-shaped failure. Default 10 minutes. 0 disables this cooldown tier. */
	cooldownMs?: number;
	/** How long (ms) to skip an engine's rotation slot after a quota-exhaustion-shaped failure (see {@link isLikelyQuotaExceededError}). Default 6 hours. 0 disables this cooldown tier. */
	quotaCooldownMs?: number;
	/** Defaults to isLikelyRateLimitError. */
	isRateLimitError?: RateLimitPredicate;
	/** Defaults to isLikelyQuotaExceededError. Checked before isRateLimitError. */
	isQuotaError?: RateLimitPredicate;
	/** Clock, injectable for tests. Defaults to Date.now. */
	now?: () => number;
	/** Called once per engine failure, including a cooldown skip. Index only, not a name (mirrors FallbackSearchEngineOptions.onEngineFailure). */
	onEngineFailure?: (engineIndex: number, error: unknown, reason: EngineFailureReason) => void;
}

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
export class RoundRobinSearchEngine implements ISearchEngine {
	private cursor = 0;
	private readonly cooldownMs: number;
	private readonly quotaCooldownMs: number;
	private readonly isRateLimitError: RateLimitPredicate;
	private readonly isQuotaError: RateLimitPredicate;
	private readonly now: () => number;
	private readonly onEngineFailure: RoundRobinSearchEngineOptions["onEngineFailure"];
	private readonly cooldownUntil: number[];

	constructor(
		private readonly engines: ISearchEngine[],
		opts: RoundRobinSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("RoundRobinSearchEngine requires at least one engine");
		this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
		this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
		this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
		this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
		this.now = opts.now ?? Date.now;
		this.onEngineFailure = opts.onEngineFailure;
		this.cooldownUntil = engines.map(() => 0);
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		const start = this.cursor;
		this.cursor = (start + 1) % this.engines.length;

		let index = -1;
		for (let attempt = 0; attempt < this.engines.length; attempt++) {
			const candidate = (start + attempt) % this.engines.length;
			if ((this.cooldownUntil[candidate] as number) > this.now()) {
				const cooldownError = new Error(`engine ${candidate} skipped: in cooldown after a recent rate-limit/quota error`);
				this.onEngineFailure?.(candidate, cooldownError, "cooldown");
				continue;
			}
			index = candidate;
			break;
		}

		if (index === -1) throw new Error("RoundRobinSearchEngine: every engine is currently in cooldown");

		try {
			return await (this.engines[index] as ISearchEngine).search(req);
		} catch (err) {
			if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
				this.cooldownUntil[index] = this.now() + this.quotaCooldownMs;
				this.onEngineFailure?.(index, err, "quota");
			} else {
				if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
					this.cooldownUntil[index] = this.now() + this.cooldownMs;
				}
				this.onEngineFailure?.(index, err, "error");
			}
			throw err;
		}
	}
}
