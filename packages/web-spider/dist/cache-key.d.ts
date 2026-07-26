/**
 * Canonical cache-key form of a URL — the same logical request should
 * produce the same key regardless of a trailing slash, fragment, or
 * query-parameter order, none of which change what a real server actually
 * returns. Falls back to the raw string for a URL that fails to parse
 * (matching every cache's existing "swallow and use as-is" behavior).
 *
 * Shared by every cache implementation in this project (SpiderCache,
 * DiskCache, the daemon's SQLiteCacheStore) so "what counts as the same
 * URL" is defined once, not reimplemented per adapter.
 */
export declare function canonicalizeUrl(url: string): string;
//# sourceMappingURL=cache-key.d.ts.map