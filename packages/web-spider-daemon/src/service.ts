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
import { DomainThrottle, PlaywrightHttpClient, RobotsCache, type IHttpClient, type WebSearchResult } from "@danypops/web-spider";
import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { VERSION } from "./version.ts";
import { openWebSpiderDb, schemaVersion } from "./db.ts";
import { SQLiteCacheStore } from "./adapters/sqlite-cache-store.ts";
import { importLegacyJsonCache, type LegacyImportResult } from "./migrate-legacy-cache.ts";
import { createEngineResolver, WebSearchService, type WebSearchInput, type WebSearchOutput } from "./search-service.ts";
import { FetchService, type FetchOperationInput, type FetchOperationOutput } from "./fetch-service.ts";
import { CrawlService, type CrawlOperationInput, type CrawlOperationOutput } from "./crawl-service.ts";
import { PapyrusIngestService, type PapyrusIngestInput, type PapyrusIngestOutput } from "./papyrus-ingest-service.ts";
import { PapyrusHttpAdapter } from "./adapters/papyrus-http-adapter.ts";
import { PlaywrightSessionRegistry } from "./adapters/playwright-session-registry.ts";
import { SQLiteSessionAuditJournal } from "./adapters/sqlite-session-audit-journal.ts";
import { SessionNotFoundError, SessionService, StaleSnapshotError, type SessionActInput, type SessionActOutput, type SessionCloseInput } from "./session-service.ts";
import type { SessionAction } from "./domain/session-audit.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { CachedPageListFilter, CachedPageListResult, CachedPageSearchResult } from "./domain/page.ts";
import type { CacheStore } from "./ports/cache-store.ts";

export const EXPECTED_OPERATION_NAMES = [
	"cache.list", "cache.search", "search", "fetch", "crawl", "papyrus.ingest",
	"session.create", "session.list", "session.close", "session.act",
] as const;
export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];

export interface OperationInputs {
	"cache.list": CachedPageListFilter;
	"cache.search": { query: string; limit?: number };
	"search": WebSearchInput;
	"fetch": FetchOperationInput;
	"crawl": CrawlOperationInput;
	"papyrus.ingest": PapyrusIngestInput;
	"session.create": { name: string; forceChromeChannel?: boolean };
	"session.list": Record<string, never>;
	"session.close": SessionCloseInput;
	"session.act": SessionActInput;
}
export interface OperationOutputs {
	"cache.list": CachedPageListResult;
	"cache.search": CachedPageSearchResult;
	"search": WebSearchOutput;
	"fetch": FetchOperationOutput;
	"crawl": CrawlOperationOutput;
	"papyrus.ingest": PapyrusIngestOutput;
	"session.create": SessionInfo;
	"session.list": { sessions: SessionInfo[] };
	"session.close": { name: string; closed: true };
	"session.act": SessionActOutput;
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
	};
}

const SESSION_ACTIONS = new Set<SessionAction>(["navigate", "click", "eval", "screenshot"]);

function sessionActInput(input: OperationInput): SessionActInput {
	const name = requireString(input, "name");
	const snapshotVersionRaw = input.snapshotVersion;
	if (typeof snapshotVersionRaw !== "number" || !Number.isInteger(snapshotVersionRaw) || snapshotVersionRaw < 0) {
		throw new Error("snapshotVersion is required and must be a non-negative integer");
	}
	const action = requireString(input, "action");
	if (!SESSION_ACTIONS.has(action as SessionAction)) {
		throw new Error('action must be one of "navigate", "click", "eval", "screenshot"');
	}
	return {
		name,
		snapshotVersion: snapshotVersionRaw,
		action: action as SessionAction,
		url: optionalString(input, "url"),
		selector: optionalString(input, "selector"),
		script: optionalString(input, "script"),
		timeoutMs: optionalNumber(input, "timeoutMs"),
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

function handlers(store: CacheStore, webSearch: WebSearchService, fetchService: FetchService, crawlService: CrawlService, papyrusIngest: PapyrusIngestService, sessionService: SessionService): Record<OperationName, OperationHandler> {
	return {
		"cache.list": (input) => store.list({
			grep: optionalString(input, "grep"),
			offset: optionalNumber(input, "offset"),
			limit: optionalNumber(input, "limit"),
		}),
		"cache.search": (input) => store.search(requireString(input, "query"), {
			topN: optionalNumber(input, "limit"),
		}),
		"search": (input) => webSearch.search({
			query: requireString(input, "query"),
			numResults: optionalNumber(input, "numResults"),
			timeRange: optionalString(input, "timeRange") as WebSearchInput["timeRange"],
			topic: optionalString(input, "topic") as WebSearchInput["topic"],
			searchEngine: optionalString(input, "searchEngine") as WebSearchInput["searchEngine"],
		}),
		"fetch": (input) => fetchService.fetch(fetchInput(input)),
		"crawl": (input) => crawlService.crawl({
			...fetchInput(input),
			format: optionalString(input, "format") as CrawlOperationInput["format"],
			depth: optionalNumber(input, "depth"),
			maxPages: optionalNumber(input, "maxPages"),
			sameDomain: optionalBoolean(input, "sameDomain"),
		}),
		"papyrus.ingest": (input) => papyrusIngest.ingest(papyrusIngestInput(input)),
		"session.create": (input) => sessionService.create({ name: requireString(input, "name"), forceChromeChannel: optionalBoolean(input, "forceChromeChannel") }),
		"session.list": () => ({ sessions: sessionService.list() }),
		"session.close": (input) => sessionService.close({ name: requireString(input, "name") }),
		"session.act": (input) => sessionService.act(sessionActInput(input)),
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

export function createWebSpiderService(path: string): WebSpiderService {
	const db = openWebSpiderDb(path);
	// :memory: databases (tests) have no sibling directory to spill large images into —
	// use an isolated temp directory instead of guessing a path relative to cwd.
	const imagesDir = path === ":memory:" ? mkdtempSync(join(tmpdir(), "web-spider-images-")) : join(dirname(path), "images");
	const store = new SQLiteCacheStore(db, { imagesDir });
	// Provider API keys are read from this (daemon) process's own environment only —
	// never accepted as operation input, never logged.
	const webSearch = new WebSearchService(createEngineResolver());

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
			const executablePath = process.env["WEB_SPIDER_PLAYWRIGHT_EXECUTABLE"];
			playwrightClient = new PlaywrightHttpClient(executablePath ? { executablePath } : undefined);
		}
		return playwrightClient;
	};
	const fetchService = new FetchService({ cache: store, throttle, robotsCache, getPlaywrightClient });
	const crawlService = new CrawlService({ cache: store, throttle, robotsCache, getPlaywrightClient });
	// Papyrus is a peer daemon, reached only through its own authenticated
	// client (PapyrusHttpAdapter) — never opened as a database directly.
	const papyrusIngest = new PapyrusIngestService(store, new PapyrusHttpAdapter());

	const sessionRegistry = new PlaywrightSessionRegistry();
	const sessionAuditJournal = new SQLiteSessionAuditJournal(db);
	const sessionService = new SessionService(sessionRegistry, sessionAuditJournal);

	const registry = handlers(store, webSearch, fetchService, crawlService, papyrusIngest, sessionService);
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
		checkpoint: () => { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
		optimize: () => { db.exec("PRAGMA optimize"); },
		close: () => {
			// Best-effort — daemon shutdown must not hang or crash on a stuck browser process.
			// playwrightClient (the enhanced:true fetch/crawl browser) is launched lazily
			// once and reused for the daemon's whole lifetime (see getPlaywrightClient()
			// above) -- found via a real leaked Chrome process still running hours after
			// the fetch that launched it: nothing ever closed it, including on shutdown.
			void playwrightClient?.close?.();
			void sessionRegistry.closeAll();
			db.exec("PRAGMA optimize");
			db.close();
		},
	};
}

function json(value: unknown, init?: ResponseInit): Response {
	return Response.json(value, init);
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
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder().decode(bytes)) as { op?: unknown; input?: unknown };
}

export function createApp(deps: { service: WebSpiderService; token: string }): { fetch(request: Request): Promise<Response> } {
	return {
		async fetch(request: Request): Promise<Response> {
			if (request.headers.get("authorization") !== `Bearer ${deps.token}`) {
				return json({ error: "missing or invalid bearer token" }, { status: 401 });
			}
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") {
				return json({ ok: true, version: VERSION, schema: deps.service.schemaState() });
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				return json({ ready: true });
			}
			if (request.method === "GET" && url.pathname === "/api/v1/ops") {
				return json({ operations: deps.service.operationNames() });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/ops") {
				try {
					const body = await readOperationBody(request);
					if (typeof body.op !== "string") return json({ error: "op is required" }, { status: 400 });
					const input = body.input === undefined ? {} : body.input;
					if (typeof input !== "object" || input === null || Array.isArray(input)) {
						return json({ error: "input must be an object" }, { status: 400 });
					}
					return json({ result: await deps.service.execute(body.op, input as OperationInput) });
				} catch (error) {
					const status = error instanceof PayloadTooLargeError ? 413
						: error instanceof UnknownOperationError || error instanceof SessionNotFoundError ? 404
							: error instanceof StaleSnapshotError ? 409
								: 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
