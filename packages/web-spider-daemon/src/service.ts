/**
 * Authenticated operation registry — mirrors papyrus/src/service.ts's
 * EXPECTED_OPERATION_NAMES + typed OperationInputs/OperationOutputs pattern.
 *
 * `cache.list` and `cache.search` are the first two real operations,
 * proving the full path: HTTP → auth → SQLite → typed response, and
 * preserving the grep/offset/limit/query semantics of today's pi-extension
 * handleCacheListing/handleCacheSearch. Later tasks (fetch/crawl/search)
 * add operations here without touching the auth/transport shape.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger, type Logger } from "@danypops/vehicle-server/logging";
import { errorResponse, healthResponse, jsonResponse, readyResponse, requireBearerToken } from "@danypops/vehicle-server/rpc-http";
import { DomainThrottle, type IHttpClient, PlaywrightHttpClient, RobotsCache, type WebSearchResult } from "@danypops/web-spider";
import { PapyrusHttpAdapter } from "./adapters/papyrus-http-adapter.ts";
import { PlaywrightSessionRegistry } from "./adapters/playwright-session-registry.ts";
import { SQLiteCacheStore } from "./adapters/sqlite-cache-store.ts";
import { SQLiteSearchUsageJournal } from "./adapters/sqlite-search-usage-journal.ts";
import { SQLiteSessionAuditJournal } from "./adapters/sqlite-session-audit-journal.ts";
import {
	SEARCH_ENGINE_USAGE_LIST_DEFAULT_LIMIT,
	SERVICE_MAX_BODY_BYTES,
	SESSION_DOWNLOADS_DIRECTORY_NAME,
	SQLITE_SCHEMA_VERSION,
} from "./constants.ts";
import { type CrawlOperationInput, type CrawlOperationOutput, CrawlService } from "./crawl-service.ts";
import { openWebSpiderDb, schemaVersion } from "./db.ts";
import type {
	CachedPageListFilter,
	CachedPageListResult,
	CachedPageSearchResult,
	CategoryAssignmentResult,
	CategoryListResult,
	CategoryRenameResult,
} from "./domain/page.ts";
import type { SearchEngineUsageEntry } from "./domain/search-usage.ts";
import type { SessionInfo } from "./domain/session.ts";
import { isSessionAction, SESSION_ACTIONS, type SessionAction } from "./domain/session-audit.ts";
import { type FetchOperationInput, type FetchOperationOutput, FetchService } from "./fetch-service.ts";
import { importLegacyJsonCache, type LegacyImportResult } from "./migrate-legacy-cache.ts";
import { type PapyrusIngestInput, type PapyrusIngestOutput, PapyrusIngestService } from "./papyrus-ingest-service.ts";
import type { CacheStore } from "./ports/cache-store.ts";
import type { SearchUsageJournal } from "./ports/search-usage-journal.ts";
import { createEngineResolver, type WebSearchInput, type WebSearchOutput, WebSearchService } from "./search-service.ts";
import {
	type SessionActInput,
	type SessionActOutput,
	type SessionCloseInput,
	SessionNotFoundError,
	SessionService,
	StaleSnapshotError,
} from "./session-service.ts";
import { VERSION } from "./version.ts";

export const EXPECTED_OPERATION_NAMES = [
	"cache.list",
	"cache.search",
	"search",
	"search.usage",
	"fetch",
	"crawl",
	"papyrus.ingest",
	"session.create",
	"session.list",
	"session.close",
	"session.act",
	"category.assign",
	"category.remove",
	"category.rename",
	"category.list",
] as const;
export type OperationName = (typeof EXPECTED_OPERATION_NAMES)[number];

export interface OperationInputs {
	"cache.list": CachedPageListFilter;
	"cache.search": { query: string; limit?: number };
	search: WebSearchInput;
	"search.usage": { engine?: string; limit?: number };
	fetch: FetchOperationInput;
	crawl: CrawlOperationInput;
	"papyrus.ingest": PapyrusIngestInput;
	"session.create": { name: string; forceChromeChannel?: boolean };
	"session.list": Record<string, never>;
	"session.close": SessionCloseInput;
	"session.act": SessionActInput;
	"category.assign": { url: string; category: string };
	"category.remove": { url: string; category: string };
	"category.rename": { category: string; newName: string };
	"category.list": Record<string, never>;
}
export interface OperationOutputs {
	"cache.list": CachedPageListResult;
	"cache.search": CachedPageSearchResult;
	search: WebSearchOutput;
	"search.usage": { entries: SearchEngineUsageEntry[] };
	fetch: FetchOperationOutput;
	crawl: CrawlOperationOutput;
	"papyrus.ingest": PapyrusIngestOutput;
	"session.create": SessionInfo;
	"session.list": { sessions: SessionInfo[] };
	"session.close": { name: string; closed: true };
	"session.act": SessionActOutput;
	"category.assign": CategoryAssignmentResult;
	"category.remove": { url: string; category: string; removed: true };
	"category.rename": CategoryRenameResult;
	"category.list": CategoryListResult;
}

type OperationInput = Record<string, unknown>;
type OperationHandler = (input: OperationInput) => unknown | Promise<unknown>;

export class UnknownOperationError extends Error {}
export class PayloadTooLargeError extends Error {}

function requireString(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string") throw new Error(`${key} is required`);
	return value;
}

function optionalString(input: OperationInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${key} must be a string`);
	return value;
}

function optionalNumber(input: OperationInput, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
	return value;
}

function optionalBoolean(input: OperationInput, key: string): boolean | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
	return value;
}

function fetchInput(input: OperationInput): FetchOperationInput {
	return {
		url: requireString(input, "url"),
		format: optionalString(input, "format") as FetchOperationInput["format"],
		rootSelector: optionalString(input, "rootSelector"),
		excludeSelectors: optionalString(input, "excludeSelectors"),
		tokenBudget: optionalNumber(input, "tokenBudget"),
		enhanced: optionalBoolean(input, "enhanced"),
		timeoutMs: optionalNumber(input, "timeoutMs"),
		query: optionalString(input, "query"),
		path: optionalString(input, "path"),
		topN: optionalNumber(input, "topN"),
		ignoreRobots: optionalBoolean(input, "ignoreRobots"),
	};
}

const TAB_OPERATIONS = new Set(["list", "new", "close", "select"]);
const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);
const ELEMENT_STATES = new Set(["visible", "hidden", "attached", "detached"]);
const SCREENSHOT_SCALES = new Set(["css", "device"]);
const SNAPSHOT_MODES = new Set(["ai", "default"]);

function sessionActInput(input: OperationInput): SessionActInput {
	const name = requireString(input, "name");
	const snapshotVersionRaw = input.snapshotVersion;
	if (typeof snapshotVersionRaw !== "number" || !Number.isInteger(snapshotVersionRaw) || snapshotVersionRaw < 0) {
		throw new Error("snapshotVersion is required and must be a non-negative integer");
	}
	const action = requireString(input, "action");
	if (!isSessionAction(action)) {
		throw new Error(`action must be one of ${[...SESSION_ACTIONS].map((a) => `"${a}"`).join(", ")}`);
	}
	const loadState = optionalString(input, "loadState");
	if (loadState !== undefined && !LOAD_STATES.has(loadState)) {
		throw new Error('loadState must be one of "load", "domcontentloaded", "networkidle"');
	}
	const state = optionalString(input, "state");
	if (state !== undefined && !ELEMENT_STATES.has(state)) {
		throw new Error('state must be one of "visible", "hidden", "attached", "detached"');
	}
	const scale = optionalString(input, "scale");
	if (scale !== undefined && !SCREENSHOT_SCALES.has(scale)) {
		throw new Error('scale must be one of "css", "device"');
	}
	const mode = optionalString(input, "mode");
	if (mode !== undefined && !SNAPSHOT_MODES.has(mode)) {
		throw new Error('mode must be one of "ai", "default"');
	}
	const tabOperation = optionalString(input, "tabOperation");
	if (tabOperation !== undefined && !TAB_OPERATIONS.has(tabOperation)) {
		throw new Error('tabOperation must be one of "list", "new", "close", "select"');
	}
	return {
		name,
		snapshotVersion: snapshotVersionRaw,
		action: action as SessionAction,
		url: optionalString(input, "url"),
		selector: optionalString(input, "selector"),
		script: optionalString(input, "script"),
		timeoutMs: optionalNumber(input, "timeoutMs"),
		text: optionalString(input, "text"),
		clear: optionalBoolean(input, "clear"),
		value: optionalString(input, "value"),
		label: optionalString(input, "label"),
		loadState: loadState as SessionActInput["loadState"],
		state: state as SessionActInput["state"],
		fullPage: optionalBoolean(input, "fullPage"),
		scale: scale as SessionActInput["scale"],
		depth: optionalNumber(input, "depth"),
		boxes: optionalBoolean(input, "boxes"),
		mode: mode as SessionActInput["mode"],
		accept: optionalBoolean(input, "accept"),
		promptText: optionalString(input, "promptText"),
		key: optionalString(input, "key"),
		includeStatic: optionalBoolean(input, "includeStatic"),
		tabOperation: tabOperation as SessionActInput["tabOperation"],
		tabIndex: optionalNumber(input, "tabIndex"),
	};
}

function papyrusIngestInput(input: OperationInput): PapyrusIngestInput {
	const kind = requireString(input, "kind");
	const relatesTo = optionalString(input, "relatesTo");
	if (kind === "pages") {
		const urls = input.urls;
		if (!Array.isArray(urls) || urls.some((u) => typeof u !== "string")) throw new Error("urls must be an array of strings");
		return { kind: "pages", urls: urls as string[], relatesTo };
	}
	if (kind === "search") {
		const results = input.results;
		if (!Array.isArray(results)) throw new Error("results must be an array");
		return {
			kind: "search",
			query: requireString(input, "query"),
			engine: optionalString(input, "engine"),
			results: results as WebSearchResult[],
			relatesTo,
		};
	}
	throw new Error('kind must be "pages" or "search"');
}

function handlers(
	store: CacheStore,
	webSearch: WebSearchService,
	fetchService: FetchService,
	crawlService: CrawlService,
	papyrusIngest: PapyrusIngestService,
	sessionService: SessionService,
	searchUsage: SearchUsageJournal,
): Record<OperationName, OperationHandler> {
	return {
		"cache.list": (input) =>
			store.list({
				grep: optionalString(input, "grep"),
				domain: optionalString(input, "domain"),
				tag: optionalString(input, "tag"),
				category: optionalString(input, "category"),
				fetchedAfter: optionalNumber(input, "fetchedAfter"),
				fetchedBefore: optionalNumber(input, "fetchedBefore"),
				publishedAfter: optionalString(input, "publishedAfter"),
				publishedBefore: optionalString(input, "publishedBefore"),
				sortBy: optionalString(input, "sortBy") as CachedPageListFilter["sortBy"],
				sortOrder: optionalString(input, "sortOrder") as CachedPageListFilter["sortOrder"],
				offset: optionalNumber(input, "offset"),
				limit: optionalNumber(input, "limit"),
			}),
		"cache.search": (input) =>
			store.search(requireString(input, "query"), {
				topN: optionalNumber(input, "limit"),
			}),
		search: (input) =>
			webSearch.search({
				query: requireString(input, "query"),
				numResults: optionalNumber(input, "numResults"),
				timeRange: optionalString(input, "timeRange") as WebSearchInput["timeRange"],
				topic: optionalString(input, "topic") as WebSearchInput["topic"],
				searchEngine: optionalString(input, "searchEngine") as WebSearchInput["searchEngine"],
			}),
		"search.usage": (input) => ({
			entries: searchUsage.recent({
				engine: optionalString(input, "engine"),
				limit: optionalNumber(input, "limit") ?? SEARCH_ENGINE_USAGE_LIST_DEFAULT_LIMIT,
			}),
		}),
		fetch: (input) => fetchService.fetch(fetchInput(input)),
		crawl: (input) =>
			crawlService.crawl({
				...fetchInput(input),
				format: optionalString(input, "format") as CrawlOperationInput["format"],
				depth: optionalNumber(input, "depth"),
				maxPages: optionalNumber(input, "maxPages"),
				sameDomain: optionalBoolean(input, "sameDomain"),
			}),
		"papyrus.ingest": (input) => papyrusIngest.ingest(papyrusIngestInput(input)),
		"session.create": (input) =>
			sessionService.create({ name: requireString(input, "name"), forceChromeChannel: optionalBoolean(input, "forceChromeChannel") }),
		"session.list": () => ({ sessions: sessionService.list() }),
		"session.close": (input) => sessionService.close({ name: requireString(input, "name") }),
		"session.act": (input) => sessionService.act(sessionActInput(input)),
		"category.assign": (input) => store.assignCategory(requireString(input, "url"), requireString(input, "category")),
		"category.remove": (input) => {
			const url = requireString(input, "url");
			const category = requireString(input, "category");
			store.removeCategory(url, category);
			return { url, category, removed: true as const };
		},
		"category.rename": (input) => store.renameCategory(requireString(input, "category"), requireString(input, "newName")),
		"category.list": () => store.listCategories(),
	};
}

export interface SchemaState {
	current: number;
	required: number;
}

export interface WebSpiderService {
	operationNames(): OperationName[];
	schemaState(): SchemaState;
	execute(operation: string, input?: OperationInput): Promise<unknown>;
	/** Best-effort, one-time import of a pre-daemon JSON DiskCache. No-op once the store already has rows. */
	importLegacyCacheIfEmpty(jsonPath: string): LegacyImportResult;
	checkpoint(): void;
	optimize(): void;
	close(): void;
}

export function createWebSpiderService(
	path: string,
	deps: { logger?: Logger; env?: Record<string, string | undefined> } = {},
): WebSpiderService {
	const db = openWebSpiderDb(path);
	// :memory: databases (tests) have no sibling directory to spill large images into —
	// use an isolated temp directory instead of guessing a path relative to cwd.
	const imagesDir = path === ":memory:" ? mkdtempSync(join(tmpdir(), "web-spider-images-")) : join(dirname(path), "images");
	// Same derivation as imagesDir above — a sibling of the database, or an
	// isolated temp directory for :memory: (test) databases with no sibling
	// directory to spill downloaded files into.
	const downloadsBaseDir =
		path === ":memory:" ? mkdtempSync(join(tmpdir(), "web-spider-downloads-")) : join(dirname(path), SESSION_DOWNLOADS_DIRECTORY_NAME);
	const store = new SQLiteCacheStore(db, { imagesDir });
	const logger = deps.logger ?? createLogger("web-spider-daemon");
	// Provider API keys are read from this (daemon) process's own environment only —
	// never accepted as operation input, never logged; onEngineFailure logs only
	// the engine name and error message, never a key. deps.env is the Enigma-augmented
	// environment resolveSearchEnv() built at startup (see daemon.ts); defaults to the
	// raw process environment for callers (tests) that construct this directly.
	const searchUsage = new SQLiteSearchUsageJournal(db);
	const webSearch = new WebSearchService(
		createEngineResolver(
			deps.env ?? process.env,
			(engineName, error, reason) => {
				logger.warn("web_search_engine_degraded", {
					engine: engineName,
					reason,
					error: error instanceof Error ? error.message : String(error),
				});
			},
			(engineName, usage) => {
				searchUsage.record({ engine: engineName, observedAt: Date.now(), ...usage });
				logger.debug("web_search_engine_usage", { engine: engineName, ...usage });
			},
		),
	);

	// Daemon-process-wide throttle/robots singletons — replaces the pi-extension's
	// per-session instances with per-daemon ones, a more correct scope since the
	// daemon is now the sole process performing fetches.
	const throttle = new DomainThrottle({ minDelayMs: 500 });
	const robotsCache = new RobotsCache();
	// Typed as PlaywrightHttpClient (not the generic IHttpClient) specifically so
	// close() below can release it — IHttpClient itself declares no close() method.
	let playwrightClient: PlaywrightHttpClient | undefined;
	const getPlaywrightClient = (): IHttpClient => {
		if (!playwrightClient) {
			const executablePath = process.env.WEB_SPIDER_PLAYWRIGHT_EXECUTABLE;
			playwrightClient = new PlaywrightHttpClient(executablePath ? { executablePath } : undefined);
		}
		return playwrightClient;
	};
	const fetchService = new FetchService({ cache: store, throttle, robotsCache, getPlaywrightClient, logger });
	const crawlService = new CrawlService({ cache: store, throttle, robotsCache, getPlaywrightClient, logger });
	// Papyrus is a peer daemon, reached only through its own authenticated
	// client (PapyrusHttpAdapter) — never opened as a database directly.
	const papyrusIngest = new PapyrusIngestService(store, new PapyrusHttpAdapter());

	const sessionRegistry = new PlaywrightSessionRegistry({ downloadsBaseDir, logger });
	const sessionAuditJournal = new SQLiteSessionAuditJournal(db);
	const sessionService = new SessionService(sessionRegistry, sessionAuditJournal, Date.now, logger);

	const registry = handlers(store, webSearch, fetchService, crawlService, papyrusIngest, sessionService, searchUsage);
	return {
		operationNames: () => [...EXPECTED_OPERATION_NAMES],
		schemaState: () => ({ current: schemaVersion(db), required: SQLITE_SCHEMA_VERSION }),
		async execute(operation, input = {}) {
			const handler = registry[operation as OperationName];
			if (!handler) throw new UnknownOperationError(`unknown operation "${operation}"`);
			return await handler(input);
		},
		importLegacyCacheIfEmpty(jsonPath) {
			const { total } = store.list({ limit: 1 });
			if (total > 0) return { imported: 0, skipped: true };
			return importLegacyJsonCache(store, jsonPath);
		},
		checkpoint: () => {
			db.exec("PRAGMA wal_checkpoint(PASSIVE)");
		},
		optimize: () => {
			db.exec("PRAGMA optimize");
		},
		close: () => {
			// Best-effort — daemon shutdown must not hang or crash on a stuck browser process.
			// playwrightClient (the enhanced:true fetch/crawl browser) is launched lazily
			// once and reused for the daemon's whole lifetime (see getPlaywrightClient()
			// above) -- found via a real leaked Chrome process still running hours after
			// the fetch that launched it: nothing ever closed it, including on shutdown.
			playwrightClient?.close?.().catch((err) => logger.warn("playwright_close_failed", { error: String(err) }));
			void sessionRegistry.closeAll();
			db.exec("PRAGMA optimize");
			db.close();
		},
	};
}

async function readOperationBody(request: Request): Promise<{ op?: unknown; input?: unknown }> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > SERVICE_MAX_BODY_BYTES) {
		throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
	}
	if (!request.body) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > SERVICE_MAX_BODY_BYTES) {
			await reader.cancel();
			throw new PayloadTooLargeError(`request exceeds ${SERVICE_MAX_BODY_BYTES} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as { op?: unknown; input?: unknown };
}

export function createApp(deps: { service: WebSpiderService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (!requireBearerToken(request, deps.token)) {
				return errorResponse("missing or invalid bearer token", 401);
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return healthResponse(VERSION, { schema: deps.service.schemaState() });
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				return readyResponse(true);
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return jsonResponse({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return errorResponse("op is required", 400);
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return errorResponse("input must be an object", 400);
					}
					return jsonResponse({ result: await deps.service.execute(body.op, input as OperationInput) });
				} catch (error) {
					const status =
						error instanceof PayloadTooLargeError
							? 413
							: error instanceof UnknownOperationError || error instanceof SessionNotFoundError
								? 404
								: error instanceof StaleSnapshotError
									? 409
									: 400;
					return errorResponse(error instanceof Error ? error.message : String(error), status);
				}
			}
			return errorResponse("not found", 404);
		},
	};
}
