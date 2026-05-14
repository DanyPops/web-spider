/**
 * Minimal robots.txt fetcher and per-domain cache.
 * Respects User-agent: * directives (Allow, Disallow, Crawl-delay).
 * Fails open — any fetch/parse error allows all URLs.
 */
export declare class RobotsCache {
    private readonly cache;
    private readonly userAgent;
    constructor(userAgent?: string);
    /**
     * Returns whether the URL is allowed and the crawl-delay if specified.
     * Caches per origin for 1 hour. Fails open on any error.
     */
    check(url: string): Promise<{
        allowed: boolean;
        crawlDelayMs?: number;
    }>;
    private fetchRobots;
}
//# sourceMappingURL=robots.d.ts.map