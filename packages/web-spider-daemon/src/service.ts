/**
 * Authenticated operation registry — mirrors papyrus/src/service.ts's
 * EXPECTED_OPERATION_NAMES + typed OperationInputs/OperationOutputs pattern.
 *
 * The walking skeleton ships exactly one real operation, `cache.list`,
 * proving the full path: HTTP → auth → SQLite → typed response. Later
 * tasks (fetch/crawl/search) add operations here without touching the
 * auth/transport shape.
 */
import { SERVICE_MAX_BODY_BYTES, SQLITE_SCHEMA_VERSION } from "./constants.ts";
import { VERSION } from "./version.ts";
import { openWebSpiderDb, schemaVersion } from "./db.ts";
import { SQLitePageStore } from "./adapters/sqlite-page-store.ts";
import type { CachedPageListFilter, CachedPageListResult } from "./domain/page.ts";
import type { PageStore } from "./ports/page-store.ts";

export const EXPECTED_OPERATION_NAMES = ["cache.list"] as const;
export type OperationName = typeof EXPECTED_OPERATION_NAMES[number];

export interface OperationInputs {
	"cache.list": CachedPageListFilter;
}
export interface OperationOutputs {
	"cache.list": CachedPageListResult;
}

type OperationInput = Record<string, unknown>;
type OperationHandler = (input: OperationInput) => unknown;

export class UnknownOperationError extends Error {}
export class PayloadTooLargeError extends Error {}

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

function handlers(pages: PageStore): Record<OperationName, OperationHandler> {
	return {
		"cache.list": (input) => pages.list({
			grep: optionalString(input, "grep"),
			offset: optionalNumber(input, "offset"),
			limit: optionalNumber(input, "limit"),
		}),
	};
}

export interface SchemaState {
	current: number;
	required: number;
}

export interface WebSpiderService {
	operationNames(): OperationName[];
	schemaState(): SchemaState;
	execute(operation: string, input?: OperationInput): unknown;
	checkpoint(): void;
	optimize(): void;
	close(): void;
}

export function createWebSpiderService(path: string): WebSpiderService {
	const db = openWebSpiderDb(path);
	const pages = new SQLitePageStore(db);
	const registry = handlers(pages);
	return {
		operationNames: () => [...EXPECTED_OPERATION_NAMES],
		schemaState: () => ({ current: schemaVersion(db), required: SQLITE_SCHEMA_VERSION }),
		execute(operation, input = {}) {
			const handler = registry[operation as OperationName];
			if (!handler) throw new UnknownOperationError(`unknown operation "${operation}"`);
			return handler(input);
		},
		checkpoint: () => { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); },
		optimize: () => { db.exec("PRAGMA optimize"); },
		close: () => {
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
					return json({ result: deps.service.execute(body.op, input as OperationInput) });
				} catch (error) {
					const status = error instanceof PayloadTooLargeError ? 413 : error instanceof UnknownOperationError ? 404 : 400;
					return json({ error: error instanceof Error ? error.message : String(error) }, { status });
				}
			}
			return json({ error: "not found" }, { status: 404 });
		},
	};
}
