/**
 * Minimal robots.txt fetcher and per-domain cache.
 * Respects User-agent: * directives (Allow, Disallow, Crawl-delay).
 * Fails open — any fetch/parse error allows all URLs.
 */
import type { IRobotsChecker, RobotsResult } from "./ports.js";
export declare class RobotsCache implements IRobotsChecker {
    private readonly cache;
    private readonly userAgent;
    constructor(userAgent?: string);
    /**
     * Returns whether the URL is allowed and the crawl-delay if specified.
     * Caches per origin for 1 hour. Fails open on any error.
     */
    check(url: string): Promise<RobotsResult>;
    private fetchRobots;
}
/**
 * Factory — avoids jiti/Bun CJS re-export interop where class constructors
 * accessed through a re-export chain can appear undefined at call site.
 * Use this in extension code instead of `new RobotsCache()`.
 */
export declare function createRobotsCache(userAgent?: string): RobotsCache;
//# sourceMappingURL=robots.d.ts.map