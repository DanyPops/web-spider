/**
 * Per-domain request throttle with exponential backoff and jitter.
 *
 * Enforces a minimum gap between requests to the same hostname.
 * On 429/503, backs off exponentially and respects Retry-After headers.
 * Shared instances should be passed into spider() and crawl() so that
 * all requests to a domain coordinate through one rate limiter.
 */
export interface ThrottleOptions {
    /** Minimum gap between requests to the same domain (ms). Default 500. */
    minDelayMs?: number;
    /** Base for exponential backoff (ms). Default 1000. */
    backoffBaseMs?: number;
    /** Maximum backoff delay (ms). Default 30 000. */
    backoffCapMs?: number;
    /** Maximum retry attempts on 429/503 before giving up. Default 3. */
    maxRetries?: number;
}
export declare class DomainThrottle {
    private readonly states;
    readonly minDelayMs: number;
    readonly backoffBaseMs: number;
    readonly backoffCapMs: number;
    readonly maxRetries: number;
    constructor(opts?: ThrottleOptions);
    private state;
    /** Wait until the domain's rate limit and backoff have cleared. */
    wait(url: string): Promise<void>;
    /** Record a successful request — resets backoff for the domain. */
    success(url: string): void;
    /**
     * Record a rate-limit hit. Applies exponential backoff with jitter,
     * using Retry-After header when present. Returns the wait duration in ms.
     */
    rateLimit(url: string, retryAfterHeader: string | null): number;
    /**
     * Override the minimum delay for a specific domain.
     * Used to honour robots.txt Crawl-delay directives.
     */
    setDomainDelay(host: string, ms: number): void;
}
//# sourceMappingURL=throttle.d.ts.map