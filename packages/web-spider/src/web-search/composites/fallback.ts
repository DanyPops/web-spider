import type { ISearchEngine, SearchQuery, WebSearchResult } from "../../ports.js";
import { type EngineFailureReason, isLikelyQuotaExceededError, isLikelyRateLimitError, type RateLimitPredicate } from "./errors.js";

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
export class FallbackSearchEngine implements ISearchEngine {
	private readonly fallbackOnEmpty: boolean;
	private readonly fallbackOnError: boolean;
	private readonly cooldownMs: number;
	private readonly quotaCooldownMs: number;
	private readonly isRateLimitError: RateLimitPredicate;
	private readonly isQuotaError: RateLimitPredicate;
	private readonly now: () => number;
	private readonly onEngineFailure: FallbackSearchEngineOptions["onEngineFailure"];
	private readonly preserveEarlierError: boolean;
	/** engines[i]'s cooldown expiry (epoch ms); 0 means never in cooldown. */
	private readonly cooldownUntil: number[];

	constructor(
		private readonly engines: ISearchEngine[],
		opts: FallbackSearchEngineOptions = {},
	) {
		if (engines.length === 0) throw new Error("FallbackSearchEngine requires at least one engine");
		this.fallbackOnEmpty = opts.fallbackOnEmpty ?? true;
		this.fallbackOnError = opts.fallbackOnError ?? true;
		this.cooldownMs = opts.cooldownMs ?? 10 * 60_000;
		this.quotaCooldownMs = opts.quotaCooldownMs ?? 6 * 60 * 60_000;
		this.isRateLimitError = opts.isRateLimitError ?? isLikelyRateLimitError;
		this.isQuotaError = opts.isQuotaError ?? isLikelyQuotaExceededError;
		this.now = opts.now ?? Date.now;
		this.onEngineFailure = opts.onEngineFailure;
		this.preserveEarlierError = opts.preserveEarlierError ?? false;
		this.cooldownUntil = engines.map(() => 0);
	}

	async search(req: SearchQuery): Promise<WebSearchResult[]> {
		let firstError: unknown;
		let lastError: unknown;
		// Gates the final throw below: a later engine completing with zero hits
		// is a real empty result, never masked by an earlier engine's error.
		let anySucceeded = false;

		for (let i = 0; i < this.engines.length; i++) {
			if ((this.cooldownUntil[i] as number) > this.now()) {
				const cooldownError = new Error(`engine ${i} skipped: in cooldown after a recent rate-limit/quota error`);
				firstError ??= cooldownError;
				lastError = cooldownError;
				this.onEngineFailure?.(i, cooldownError, "cooldown");
				continue;
			}
			try {
				const results = await (this.engines[i] as ISearchEngine).search(req);
				anySucceeded = true;
				if (results.length > 0 || !this.fallbackOnEmpty) return results;
				// Empty + fallbackOnEmpty → try next engine
			} catch (err) {
				if (!this.fallbackOnError) throw err;
				firstError ??= err;
				lastError = err;
				if (this.quotaCooldownMs > 0 && this.isQuotaError(err)) {
					this.cooldownUntil[i] = this.now() + this.quotaCooldownMs;
					this.onEngineFailure?.(i, err, "quota");
				} else {
					if (this.cooldownMs > 0 && this.isRateLimitError(err)) {
						this.cooldownUntil[i] = this.now() + this.cooldownMs;
					}
					this.onEngineFailure?.(i, err, "error");
				}
				// Error + fallbackOnError → try next engine
			}
		}

		if (this.preserveEarlierError && firstError) throw firstError;
		if (!anySucceeded && lastError) throw lastError;
		return [];
	}
}
