/**
 * What one search-engine call reported about its own cost -- never a running
 * account balance, since no provider (Tavily, Exa, Brave) exposes one via
 * its search API; a consumer accumulates these rows itself for that.
 */
export interface SearchEngineUsageEntry {
	engine: string;
	observedAt: number;
	/** Credits consumed by this one call (Tavily). */
	credits?: number;
	/** Dollar cost of this one call (Exa). */
	costUsd?: number;
	/** Rate-limit-shaped response headers, when the engine sent any (Brave, unconfirmed as of this writing). */
	rateLimitHeaders?: Record<string, string>;
}
