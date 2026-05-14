import type { SpiderCache } from "./cache.js";
import type { SpiderOptions } from "./spider.js";
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
export declare function batchSpider(urls: string[], opts?: BatchOptions): Promise<Map<string, SpideredPage | Error>>;
//# sourceMappingURL=batch.d.ts.map