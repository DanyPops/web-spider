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

interface DomainState {
	lastAt: number;
	backoffUntil: number;
	errors: number;
	/** Per-domain minimum delay override (e.g. from robots.txt Crawl-delay). */
	minDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(header: string | null): number {
	if (!header) return 0;
	const seconds = parseInt(header, 10);
	if (!isNaN(seconds)) return seconds * 1_000;
	const date = new Date(header).getTime();
	if (!isNaN(date)) return Math.max(0, date - Date.now());
	return 0;
}

export class DomainThrottle {
	private readonly states = new Map<string, DomainState>();
	readonly minDelayMs: number;
	readonly backoffBaseMs: number;
	readonly backoffCapMs: number;
	readonly maxRetries: number;

	constructor(opts: ThrottleOptions = {}) {
		this.minDelayMs = opts.minDelayMs ?? 500;
		this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
		this.backoffCapMs = opts.backoffCapMs ?? 30_000;
		this.maxRetries = opts.maxRetries ?? 3;
	}

	private state(host: string): DomainState {
		let s = this.states.get(host);
		if (!s) {
			s = { lastAt: 0, backoffUntil: 0, errors: 0 };
			this.states.set(host, s);
		}
		return s;
	}

	/** Wait until the domain's rate limit and backoff have cleared. */
	async wait(url: string): Promise<void> {
		const s = this.state(new URL(url).hostname);
		const minDelay = s.minDelayMs ?? this.minDelayMs;
		const now = Date.now();
		const delay = Math.max(
			Math.max(0, s.backoffUntil - now),
			Math.max(0, s.lastAt + minDelay - now),
		);
		if (delay > 0) await sleep(delay);
		s.lastAt = Date.now();
	}

	/** Record a successful request — resets backoff for the domain. */
	success(url: string): void {
		const s = this.state(new URL(url).hostname);
		s.errors = 0;
		s.backoffUntil = 0;
	}

	/**
	 * Record a rate-limit hit. Applies exponential backoff with jitter,
	 * using Retry-After header when present. Returns the wait duration in ms.
	 */
	rateLimit(url: string, retryAfterHeader: string | null): number {
		const s = this.state(new URL(url).hostname);
		s.errors++;
		const retryAfterMs = parseRetryAfter(retryAfterHeader);
		const jitter = Math.random() * this.backoffBaseMs;
		const backoffMs = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (s.errors - 1) + jitter);
		const waitMs = Math.max(retryAfterMs, backoffMs);
		s.backoffUntil = Date.now() + waitMs;
		return waitMs;
	}

	/**
	 * Override the minimum delay for a specific domain.
	 * Used to honour robots.txt Crawl-delay directives.
	 */
	setDomainDelay(host: string, ms: number): void {
		this.state(host).minDelayMs = ms;
	}
}
