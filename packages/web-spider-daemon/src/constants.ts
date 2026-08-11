/**
 * Daemon-wide constants. Grouped by concern, not alphabetized, so related
 * bounds stay readable together. Mirrors jittor/src/constants.ts and
 * papyrus/src/constants.ts in shape and intent.
 */

// ---------------------------------------------------------------------------
// Process / storage layout
// ---------------------------------------------------------------------------
export const WEB_SPIDER_STATE_DIRECTORY = "web-spider";
export const DATABASE_FILENAME = "web-spider.db";
export const TOKEN_FILENAME = "auth-token";
export const HANDLE_FILENAME = "daemon.json";
/** Sibling of TOKEN_FILENAME (persistent state, not the ephemeral runtime-dir handle) so restart history survives across restarts -- the whole point of a lifecycle log. */
export const LIFECYCLE_LOG_FILENAME = "lifecycle.json";
/** Legacy descriptor retained only so migration tooling can locate and remove it after Armada is healthy. */
export const LEGACY_SYSTEMD_UNIT_NAME = "web-spider.service";

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
export const SQLITE_SCHEMA_VERSION = 6;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
export const DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// HTTP service
// ---------------------------------------------------------------------------
export const SERVICE_MAX_BODY_BYTES = 1_048_576;

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
export const CRAWL_DEFAULT_DEADLINE_MS = 120_000;
export const CRAWL_MAX_DEADLINE_MS_CEILING = 300_000;
export const CRAWL_MAX_TOTAL_CHARS_CEILING = 2_000_000;
/** Server-side cap on how many URLs a single crawlUrls selective-crawl request may name. */
export const CRAWL_URLS_MAX_COUNT = 50;
/** Server-side cap on how many hostnames a single crawl's excludeDomains/includeDomains may each list -- see src/fetch/domain-filter.ts. */
export const CRAWL_DOMAIN_FILTER_MAX_COUNT = 20;
export const SEARCH_DEFAULT_NUM_RESULTS = 10;
export const SEARCH_MAX_NUM_RESULTS_CEILING = 50;
export const FETCH_DEFAULT_TOKEN_BUDGET = 4_000;
export const FETCH_MAX_TOKEN_BUDGET = 10_000;
export const FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const FETCH_HIGHLIGHTS_DEFAULT_TOP_N = 5;
export const FETCH_HIGHLIGHTS_SNIPPET_RADIUS = 150;
export const CRAWL_HIGHLIGHTS_DEFAULT_TOP_N = 8;
export const TREE_QUERY_DEFAULT_TOP_N = 5;
// quotes: search + selective-fetch resource-finder op -- surfaces ranked,
// verbatim BM25F quotes per requested url (a "resource card" list), never an
// LLM-digested answer. See docs/web-fetch-api.md.
/** Server-side cap on how many ContentSourceStrategy names a single request's `sources` may list -- see src/fetch/content-sources.ts. Generously above the real built-in count (5, as of this writing) so a caller stacking several third-party strategies isn't cramped, while still bounding a pathological request. */
export const SOURCES_MAX_COUNT = 10;
/** Server-side cap on how many URLs a single quotes request may name -- same bound as CRAWL_URLS_MAX_COUNT's selective crawl. */
export const QUOTES_MAX_URLS = 50;
export const QUOTES_DEFAULT_PER_URL = 3;
/** Per-url quote cap ceiling -- mirrors Perplexity's `content snippets --max-tokens-per-page`: no single url may starve the others' share of maxQuotesTotal. */
export const QUOTES_PER_URL_CEILING = 20;
export const QUOTES_DEFAULT_TOTAL = 15;
export const QUOTES_TOTAL_CEILING = 100;
/** Session-scoped tree cache — matches the pi-extension's existing bound (constants.ts TREE_CACHE_MAX_ENTRIES). */
export const TREE_CACHE_MAX_ENTRIES = 20;

// ---------------------------------------------------------------------------
// Session registry — tmux-style browser sessions: named, persistent across
// separate tool calls, surviving until explicitly closed.
// ---------------------------------------------------------------------------
/** Each session owns a full separate Playwright Browser process — local-dev-scale, not a hosted fleet. */
export const SESSION_REGISTRY_MAX_CONCURRENT = 5;
/** Max open tabs per session — each is a real Playwright page consuming real memory. */
export const SESSION_MAX_TABS = 10;
export const SESSION_NAME_MAX_LENGTH = 64;
/** Bounded, content-free audit journal (Seeshell-derived principle) — never page text/secrets, just attempt/dispatch/result metadata. */
export const SESSION_AUDIT_LOG_MAX_ROWS = 10_000;
/** Same bound as SESSION_AUDIT_LOG_MAX_ROWS -- an append-only per-call usage log doesn't need to grow unbounded either. */
export const SEARCH_ENGINE_USAGE_LOG_MAX_ROWS = 10_000;
/** Default page size for search.usage's bounded read. */
export const SEARCH_ENGINE_USAGE_LIST_DEFAULT_LIMIT = 50;
export const SESSION_ACT_SELECTOR_MAX_LENGTH = 200;
export const SESSION_ACT_URL_MAX_LENGTH = 500;
export const SESSION_JOURNAL_ERROR_MAX_LENGTH = 300;
export const SESSION_ACT_SCRIPT_MAX_LENGTH = 10_000;
export const SESSION_ACT_DEFAULT_TIMEOUT_MS = 30_000;
/** Bounded length for a type action's text — a form-field value, never a script or document body. */
export const SESSION_ACT_TEXT_MAX_LENGTH = 2_000;
/** queryText/readTable: max items (text entries, or table rows) returned — never an unbounded page dump. */
export const SESSION_ACT_EXTRACT_MAX_ITEMS = 200;
/** queryText/readTable: max length of a single extracted string (one text entry, or one cell) — caps a pathologically large single element. */
export const SESSION_ACT_EXTRACT_ITEM_MAX_LENGTH = 2_000;
/** snapshot: max length of the returned YAML accessibility tree — a whole-tree structure, so a larger bound than a single extracted item. */
export const SESSION_ACT_SNAPSHOT_MAX_LENGTH = 20_000;
/** Subdirectory name (sibling of the SQLite database, under the same XDG_DATA_HOME) that downloaded files are saved under, one subdirectory per session. */
export const SESSION_DOWNLOADS_DIRECTORY_NAME = "downloads";
/** Max downloads tracked per session — oldest evicted first. Bounds memory, not disk (a real limitation: a single huge file is not size-bounded by this). */
export const SESSION_MAX_DOWNLOADS_TRACKED = 20;
/** Max console messages / network requests tracked per session — oldest evicted first. Larger than downloads since these fire far more frequently per page. */
export const SESSION_MAX_CONSOLE_MESSAGES_TRACKED = 100;
export const SESSION_MAX_NETWORK_REQUESTS_TRACKED = 100;
