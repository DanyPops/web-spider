/** True for a short-lived throttling response worth a brief cooldown: standard 429 and "too many requests"/"rate limit" phrasing. Distinct from {@link isLikelyQuotaExceededError} -- a request-rate throttle clears in seconds to minutes, an exhausted account quota does not. */
export function isLikelyRateLimitError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (/\b429\b/.test(error.message)) return true;
	return /rate.?limit|too many requests/i.test(error.message);
}

/** True for an account-level quota/plan exhaustion worth a much longer disable than a rate limit: Tavily's non-standard 432, 402 Payment Required, and phrasing like "quota exceeded", "usage limit", "out of searches/credits", "plan limit". Retrying before the billing/quota window resets just wastes a call and re-triggers the same failure. */
export function isLikelyQuotaExceededError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (/\b(432|402)\b/.test(error.message)) return true;
	return /quota|usage limit|out of (searches|credits)|plan limit|insufficient credits|run out of/i.test(error.message);
}

export type RateLimitPredicate = (error: unknown) => boolean;

/** "error": the engine's search() call threw a non-quota error. "quota": it threw a quota-exhaustion error (see {@link isLikelyQuotaExceededError}), the trigger for the longer quota cooldown. "cooldown": skipped without even calling it, because an earlier failure's cooldown hasn't cleared yet -- covers both the rate-limit and quota cases. */
export type EngineFailureReason = "error" | "quota" | "cooldown";
