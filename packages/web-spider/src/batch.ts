import type { SpiderCache } from "./cache.js";
import type { SpiderOptions } from "./spider.js";
import { spider } from "./spider.js";
import type { SpideredPage } from "./types.js";

export interface BatchOptions extends SpiderOptions {
	/** Max concurrent fetches (default 3 — be polite) */
	concurrency?: number;
	/** Fixed delay in ms between each fetch start (default 300) */
	delayMs?: number;
	/** Optional cache — already-cached URLs are skipped */
	cache?: SpiderCache;
	/** Called after each URL completes (success or failure) */
	onProgress?: (done: number, total: number, url: string, error?: Error) => void;
}

/**
 * Spider multiple URLs concurrently with a bounded semaphore.
 *
 * Returns a Map keyed by URL. Value is either a SpideredPage (success)
 * or an Error (failure). Errors do not poison the batch.
 *
 * Cache integration: if `opts.cache` is provided, cached pages are
 * returned immediately and do not count toward concurrency.
 */
export async function batchSpider(urls: string[], opts: BatchOptions = {}): Promise<Map<string, SpideredPage | Error>> {
	const { concurrency = 3, delayMs = 300, cache, onProgress, ...spiderOpts } = opts;

	const results = new Map<string, SpideredPage | Error>();
	const unique = [...new Set(urls)];
	let done = 0;

	// Satisfy cache hits synchronously before touching the network
	const toFetch: string[] = [];
	for (const url of unique) {
		const cached = cache?.get(url);
		if (cached) {
			results.set(url, cached);
			done++;
			onProgress?.(done, unique.length, url);
		} else {
			toFetch.push(url);
		}
	}

	if (toFetch.length === 0) return results;

	// Semaphore: at most `concurrency` in-flight at once
	let inFlight = 0;
	let index = 0;

	await new Promise<void>((resolve) => {
		const tryNext = (): void => {
			while (inFlight < concurrency && index < toFetch.length) {
				const url = toFetch[index++];
				inFlight++;

				const delay =
					delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs * (index - 1))) : Promise.resolve();

				delay
					.then(() => spider(url, spiderOpts))
					.then((page) => {
						results.set(url, page);
						cache?.set(url, page);
					})
					.catch((err: unknown) => {
						results.set(url, err instanceof Error ? err : new Error(String(err)));
					})
					.finally(() => {
						done++;
						onProgress?.(
							done,
							unique.length,
							url,
							results.get(url) instanceof Error ? (results.get(url) as Error) : undefined,
						);
						inFlight--;
						if (done === unique.length) resolve();
						else tryNext();
					});
			}
		};
		tryNext();
	});

	return results;
}
