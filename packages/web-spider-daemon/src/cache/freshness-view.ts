/**
 * A read-freshness-bounded view over an existing `ICache<string, SpideredPage>`
 * -- decorates has()/get()/values() to additionally treat a cached page older
 * than maxAgeMs as absent, using `SpideredPage.fetchedAt` (a real ISO-8601
 * timestamp every cached page already carries -- see @danypops/web-spider's
 * src/types.ts). set()/delete() delegate straight through unchanged.
 *
 * This is deliberately a decorator over the existing ICache/CacheStore
 * contract, not a change to it -- every other reader of the same shared
 * cache (a plain fetch, a crawl, another concurrent request) is completely
 * unaffected; this view's own stale-rejection is local to the one request
 * that asked for it. A "too stale" read still writes back through set()
 * exactly like a normal cache miss would, refreshing the shared entry for
 * everyone -- the "not a full bypass" property that distinguishes
 * maxCacheAgeMs from rootSelector/excludeSelectors/tokenBudget/enhanced/
 * sources, which disqualify a request from the shared cache entirely in
 * both directions (see FetchService.fetchPage's cacheEligible).
 */
import type { ICache, SpideredPage } from "@danypops/web-spider";

export function withMaxAge(cache: ICache<string, SpideredPage>, maxAgeMs: number): ICache<string, SpideredPage> {
	const boundedMaxAgeMs = Math.max(0, maxAgeMs);

	const isFresh = (page: SpideredPage): boolean => {
		const fetchedAt = Date.parse(page.fetchedAt);
		if (Number.isNaN(fetchedAt)) return false; // fail closed: an unparseable timestamp is never "fresh"
		// Strict less-than, not <=, so maxAgeMs: 0 always rejects even a same-millisecond
		// entry (age can never be negative) -- "0 always refetches" must hold exactly,
		// not just for an entry that happens to be at least 1ms old by the time it's checked.
		return Date.now() - fetchedAt < boundedMaxAgeMs;
	};

	return {
		has(url: string): boolean {
			const page = cache.get(url);
			return page !== undefined && isFresh(page);
		},
		get(url: string): SpideredPage | undefined {
			const page = cache.get(url);
			return page !== undefined && isFresh(page) ? page : undefined;
		},
		set(url: string, page: SpideredPage): void {
			cache.set(url, page);
		},
		delete(url: string): void {
			cache.delete(url);
		},
		values(): SpideredPage[] {
			return cache.values().filter(isFresh);
		},
	};
}
