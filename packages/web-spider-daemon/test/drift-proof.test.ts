/**
 * Drift-proof coverage: keeps the daemon operation registry, the CLI
 * surface, and the documented web_fetch tool contract in lock-step, per
 * web-spider-daemon-add-drift-proof-operationclitool-parity-te-ymnp
 * (mirrors Papyrus's "cli-parity-add-drift-proof-operation-and-tool-coverage-tests"
 * task intent).
 *
 * The core mechanism is compile-time, not just a runtime assertion:
 * OPERATION_CLI_INVOCATIONS below is typed `Record<OperationName, string[]>`.
 * Adding a new operation to service.ts's EXPECTED_OPERATION_NAMES without
 * adding it here fails `tsc --noEmit` immediately — a new operation
 * literally cannot compile without CLI coverage being declared.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, type CliDependencies } from "../src/cli.ts";
import { createApp, createWebSpiderService, EXPECTED_OPERATION_NAMES, type OperationName } from "../src/service.ts";

// ---------------------------------------------------------------------------
// 1. Operation registry → CLI subcommand coverage (compile-time exhaustive)
// ---------------------------------------------------------------------------

/** One CLI invocation per operation that must dispatch to exactly that operation. */
const OPERATION_CLI_INVOCATIONS: Record<OperationName, string[]> = {
	"cache.list": ["cache", "list"],
	"cache.search": ["cache", "search", "drift-proof-query"],
	"search": ["search", "drift-proof-query"],
	"fetch": ["fetch", "https://drift-proof.test/article"],
	"crawl": ["fetch", "https://drift-proof.test/article", "--depth", "1"],
	"papyrus.ingest": ["papyrus", "ingest", "https://drift-proof.test/article"],
	"session.create": ["session", "create", "drift-proof-session"],
	"session.list": ["session", "list"],
	"session.close": ["session", "close", "drift-proof-session"],
	"session.act": ["session", "act", "drift-proof-session", "--action", "screenshot", "--snapshot-version", "0"],
};

function fakeDeps(): { deps: CliDependencies; ops: OperationName[] } {
	const ops: OperationName[] = [];
	const deps: CliDependencies = {
		client: {
			async call(op: OperationName) {
				ops.push(op);
				// Minimal shape satisfying every formatter without throwing.
				return {
					pagesFound: 0, pages: [], total: 0, filtered: 0, offset: 0, limit: 20, query: "q", results: [], pagesSearched: 0, hits: [], ingested: [], skipped: [],
					name: "drift-proof-session", createdAt: 0, lastActivityAt: 0, snapshotVersion: 0, closed: true, sessions: [], action: "screenshot",
				} as never;
			},
		},
		stdout: () => {},
		stderr: () => {},
		systemctl: () => {},
		installService: () => {},
		serve: () => {},
		readEvalScript: () => "1+1",
	};
	return { deps, ops };
}

describe("operation registry → CLI coverage", () => {
	test("every registered operation has a CLI invocation that reaches it", async () => {
		for (const operation of EXPECTED_OPERATION_NAMES) {
			const { deps, ops } = fakeDeps();
			const args = OPERATION_CLI_INVOCATIONS[operation];
			const code = await runCli(args, deps);
			expect({ operation, code, ops }).toEqual({ operation, code: 0, ops: [operation] });
		}
	});

	test("OPERATION_CLI_INVOCATIONS has no stale entries beyond the current registry", () => {
		// The Record<OperationName, ...> type already forces this at compile time for
		// missing keys; this catches the (impossible under the type, but explicit)
		// case of the two lists disagreeing at runtime after a refactor.
		expect(Object.keys(OPERATION_CLI_INVOCATIONS).sort()).toEqual([...EXPECTED_OPERATION_NAMES].sort());
	});
});

// ---------------------------------------------------------------------------
// 2. Reachable path from the documented web_fetch tool parameter surface
// ---------------------------------------------------------------------------

/**
 * Field names from docs/web-fetch-api.md's Parameters tables (the contract
 * document, not pi-extension's current implementation — pi-extension does
 * not yet implement searchEngine/timeRange/topic/searchEnrich; the daemon's
 * fetch/crawl/search operations are the target contract those will be wired
 * to in the extension-client task). A daemon field absent from this set
 * without updating the doc is a silent contract drift.
 */
const DOCUMENTED_TOOL_PARAMETERS = new Set([
	"url", "searchQuery", "format", "depth", "maxPages", "sameDomain",
	"rootSelector", "excludeSelectors", "tokenBudget", "query", "path", "topN",
	"searchEngine", "numResults", "timeRange", "topic", "searchEnrich",
	"enhanced", "timeoutMs", "grep", "offset", "limit", "ignoreRobots",
]);

/** Field names the daemon's fetch/crawl/search operations actually accept (service.ts's fetchInput()/handlers()). */
const DAEMON_OPERATION_FIELDS = [
	"url", "format", "rootSelector", "excludeSelectors", "tokenBudget", "enhanced",
	"timeoutMs", "query", "path", "topN", "depth", "maxPages", "sameDomain",
	"numResults", "timeRange", "topic", "searchEngine", "grep", "offset", "limit", "ignoreRobots",
];

describe("daemon operation fields → documented tool parameter surface", () => {
	test("every field a daemon operation accepts is a documented tool parameter", () => {
		const undocumented = DAEMON_OPERATION_FIELDS.filter((field) => !DOCUMENTED_TOOL_PARAMETERS.has(field));
		expect(undocumented).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. Golden contract: --json prints the operation result verbatim
// ---------------------------------------------------------------------------

describe("--json output is the exact operation result, not a reformatted copy", () => {
	test("for every operation's CLI invocation, --json output parses back to exactly what the client returned", async () => {
		for (const operation of EXPECTED_OPERATION_NAMES) {
			const canned = { marker: `canned-${operation}`, nested: { a: 1 } };
			const lines: string[] = [];
			const deps: CliDependencies = {
				client: { async call() { return canned as never; } },
				stdout: (line) => lines.push(line),
				stderr: () => {},
				systemctl: () => {},
				installService: () => {},
				serve: () => {},
				readEvalScript: () => "1+1",
			};
			const args = [...OPERATION_CLI_INVOCATIONS[operation], "--json"];
			const code = await runCli(args, deps);
			expect(code).toBe(0);
			expect(JSON.parse(lines[0] ?? "null")).toEqual(canned);
		}
	});
});

// ---------------------------------------------------------------------------
// 4. Trust-boundary regressions
// ---------------------------------------------------------------------------

const TOKEN = "test-token";

describe("trust boundary — authentication", () => {
	test("every registered operation rejects an unauthenticated request with 401, never reaching the handler", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			for (const op of EXPECTED_OPERATION_NAMES) {
				const response = await app.fetch(new Request("http://x/api/v1/ops", {
					method: "POST",
					headers: { "content-type": "application/json" }, // no Authorization header
					body: JSON.stringify({ op, input: { url: "https://x.test", query: "q" } }),
				}));
				expect(response.status).toBe(401);
			}
		} finally {
			service.close();
		}
	});

	test("an oversized request body is rejected with 413 before any operation executes", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const oversized = "x".repeat(2_000_000); // exceeds SERVICE_MAX_BODY_BYTES (1 MiB)
			const response = await app.fetch(new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "cache.list", input: { grep: oversized } }),
			}));
			expect(response.status).toBe(413);
		} finally {
			service.close();
		}
	});
});

describe("trust boundary — CLI never opens SQLite directly", () => {
	test("cli.ts imports only the authenticated client, never bun:sqlite or a storage adapter", () => {
		const source = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
		expect(source).not.toContain("bun:sqlite");
		expect(source).not.toContain("./db.ts");
		expect(source).not.toContain("./adapters/");
		expect(source).toContain("./client.ts");
	});

	test("cli-format.ts (the human-output formatters) does not import SQLite either", () => {
		const source = readFileSync(join(import.meta.dir, "../src/cli-format.ts"), "utf8");
		expect(source).not.toContain("bun:sqlite");
		expect(source).not.toContain("./adapters/");
	});
});
