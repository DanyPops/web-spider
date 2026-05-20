/**
 * Port interfaces — the contracts the core depends on.
 *
 * No concrete imports. Adapters implement these; the core orchestrates them.
 * All ports are optional in SpiderOptions — concrete defaults are wired in
 * spider.ts and crawl.ts so callers need not supply them unless they want
 * to substitute (e.g. inject a mock HTTP client for testing).
 */

// ---------------------------------------------------------------------------
// IHttpClient
// ---------------------------------------------------------------------------

export interface HttpRequest {
	url: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface HttpResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Minimal HTTP client port.
 * Default adapter wraps global fetch().
 * Swap for tests: return fixed HTML without touching the network.
 */
export interface IHttpClient {
	fetch(req: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// ICache<K, V>
// ---------------------------------------------------------------------------

/**
 * Generic cache port.
 * Default adapter: SpiderCache (LRU, TTL).
 * Swap for tests or production: in-memory Map, Redis, SQLite, etc.
 */
export interface ICache<K, V> {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	has(key: K): boolean;
	delete(key: K): void;
	/** All currently valid (non-expired) values. */
	values(): V[];
}

// ---------------------------------------------------------------------------
// IThrottle
// ---------------------------------------------------------------------------

/**
 * Per-domain request throttle port.
 * Default adapter: DomainThrottle (token bucket + exponential backoff).
 * Swap for tests: no-op implementation that always resolves immediately.
 */
export interface IThrottle {
	wait(url: string): Promise<void>;
	success(url: string): void;
	rateLimit(url: string, retryAfterHeader: string | null): number;
	setDomainDelay(host: string, ms: number): void;
	readonly maxRetries: number;
}

// ---------------------------------------------------------------------------
// IRobotsChecker
// ---------------------------------------------------------------------------

export interface RobotsResult {
	allowed: boolean;
	crawlDelayMs?: number;
}

/**
 * robots.txt compliance port.
 * Default adapter: RobotsCache (fetches + parses per origin, 1h TTL).
 * Swap for tests: permissive stub that always returns { allowed: true }.
 */
export interface IRobotsChecker {
	check(url: string): Promise<RobotsResult>;
}

// ---------------------------------------------------------------------------
// ISearchEngine
// ---------------------------------------------------------------------------

export interface SearchQuery {
	query: string;
	numResults?: number;
}

/**
 * A single result from a web search engine.
 * Defined here so port interfaces have no dependency on adapter modules.
 */
export interface WebSearchResult {
	url: string;
	title: string;
	/** Short description or snippet from the search engine. */
	snippet: string;
	/** ISO-8601 or human-readable date, if the engine returned one. */
	publishedAt?: string;
}

/**
 * Web search engine port.
 * Adapters: BraveSearchEngine, TavilySearchEngine (in web-search.ts).
 * Swap for tests: stub returning fixed results.
 */
export interface ISearchEngine {
	search(req: SearchQuery): Promise<WebSearchResult[]>;
}
