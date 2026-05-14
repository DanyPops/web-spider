/**
 * Port interfaces — the contracts the core depends on.
 *
 * No concrete imports. Adapters implement these; the core orchestrates them.
 * All ports are optional in SpiderOptions — concrete defaults are wired in
 * spider.ts and crawl.ts so callers need not supply them unless they want
 * to substitute (e.g. inject a mock HTTP client for testing).
 */
export {};
//# sourceMappingURL=ports.js.map