/**
 * Daemon-wide constants. Grouped by concern, not alphabetized, so related
 * bounds stay readable together. Mirrors jittor/src/constants.ts and
 * papyrus/src/constants.ts in shape and intent.
 */

// ---------------------------------------------------------------------------
// Process / storage layout
// ---------------------------------------------------------------------------
export const LOOPBACK_HOST = "127.0.0.1";
export const WEB_SPIDER_STATE_DIRECTORY = "web-spider";
export const DATABASE_FILENAME = "web-spider.db";
export const TOKEN_FILENAME = "auth-token";
export const HANDLE_FILENAME = "daemon.json";
export const SYSTEMD_UNIT_NAME = "web-spider.service";

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
export const SQLITE_SCHEMA_VERSION = 1;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// HTTP service
// ---------------------------------------------------------------------------
export const SERVICE_MAX_BODY_BYTES = 1_048_576;
export const DAEMON_CLIENT_TIMEOUT_MS = 15_000;
export const DAEMON_PROBE_TIMEOUT_MS = 800;

// ---------------------------------------------------------------------------
// Bounded resources (design doc §5 — never trust a client-only cap)
// ---------------------------------------------------------------------------
export const CACHE_DEFAULT_MAX_ENTRIES = 500;
export const CACHE_DEFAULT_TTL_MS = 30 * 60 * 1_000;
/** Base64 length above which an image is spilled to a file instead of stored inline — matches DiskCache's default. */
export const CACHE_DEFAULT_INLINE_IMAGE_THRESHOLD = 32 * 1_024;
export const CACHE_LIST_DEFAULT_LIMIT = 20;
export const CACHE_LIST_MAX_LIMIT = 100;
export const CACHE_SEARCH_DEFAULT_LIMIT = 10;
export const CACHE_SEARCH_SNIPPET_RADIUS = 150;
/** Default legacy JSON cache path — same default the pi-extension has used to date. */
export const LEGACY_CACHE_DEFAULT_RELATIVE_PATH = [".cache", "web-spider", "pages.json"];
export const CRAWL_DEFAULT_MAX_DEPTH = 0;
export const CRAWL_MAX_DEPTH_CEILING = 5;
export const CRAWL_DEFAULT_MAX_PAGES = 10;
export const CRAWL_MAX_PAGES_CEILING = 200;
export const SEARCH_DEFAULT_NUM_RESULTS = 10;
export const SEARCH_MAX_NUM_RESULTS_CEILING = 50;
export const FETCH_DEFAULT_TOKEN_BUDGET = 4_000;
export const FETCH_MAX_TOKEN_BUDGET = 10_000;
export const PAPYRUS_INGEST_MAX_BATCH = 20;
