import { describe, expect, test } from "bun:test";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";
import { renderSystemdUnit, runCli, type CliDependencies } from "../src/cli.ts";

interface RecordedCall { op: OperationName; input: unknown }

function fakeDeps(overrides: {
	call?: (op: OperationName, input: unknown) => unknown;
} & Partial<Omit<CliDependencies, "client">> = {}): { deps: CliDependencies; calls: string[]; operations: RecordedCall[] } {
	const calls: string[] = [];
	const operations: RecordedCall[] = [];
	const deps: CliDependencies = {
		client: {
			async call<Name extends OperationName>(op: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
				operations.push({ op, input });
				return (overrides.call?.(op, input) ?? {}) as OperationOutputs[Name];
			},
		},
		stdout: (line) => calls.push(`stdout:${line}`),
		stderr: (line) => calls.push(`stderr:${line}`),
		systemctl: (...args) => calls.push(`systemctl:${args.join(" ")}`),
		installService: () => calls.push("install"),
		serve: () => calls.push("serve"),
		...overrides,
	};
	return { deps, calls, operations };
}

describe("renderSystemdUnit", () => {
	test("renders a restart-always, no-new-privileges unit invoking serve", () => {
		const unit = renderSystemdUnit({ bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts" });
		expect(unit).toContain("ExecStart=/usr/bin/bun /opt/web-spider/cli.ts serve");
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("NoNewPrivileges=true");
		expect(unit).toContain("PrivateTmp=true");
	});

	test("omits Environment= lines entirely when no search API keys are supplied", () => {
		const unit = renderSystemdUnit({ bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts" });
		expect(unit).not.toContain("Environment=");
	});

	test("omits Environment= lines for keys that are undefined or empty", () => {
		const unit = renderSystemdUnit({
			bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts",
			searchApiKeys: { BRAVE_SEARCH_API_KEY: undefined, TAVILY_API_KEY: "", EXA_API_KEY: undefined },
		});
		expect(unit).not.toContain("Environment=");
	});

	test("renders one Environment= line per configured key, between ExecStart and Restart", () => {
		const unit = renderSystemdUnit({
			bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts",
			searchApiKeys: { TAVILY_API_KEY: "test-tavily-key", EXA_API_KEY: "test-exa-key" },
		});
		expect(unit).toContain('Environment="TAVILY_API_KEY=test-tavily-key"');
		expect(unit).toContain('Environment="EXA_API_KEY=test-exa-key"');
		expect(unit).not.toContain("BRAVE_SEARCH_API_KEY");
		const execStartIndex = unit.indexOf("ExecStart=");
		const environmentIndex = unit.indexOf("Environment=");
		const restartIndex = unit.indexOf("Restart=always");
		expect(execStartIndex).toBeLessThan(environmentIndex);
		expect(environmentIndex).toBeLessThan(restartIndex);
	});

	test("escapes backslashes and double quotes in a key value", () => {
		const unit = renderSystemdUnit({
			bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts",
			searchApiKeys: { BRAVE_SEARCH_API_KEY: 'weird"value\\with-escapes' },
		});
		expect(unit).toContain('Environment="BRAVE_SEARCH_API_KEY=weird\\"value\\\\with-escapes"');
	});
});

describe("runCli — serve / service (unchanged surface)", () => {
	test("serve invokes the serve dependency", async () => {
		const { deps, calls } = fakeDeps();
		const code = await runCli(["serve"], deps);
		expect(code).toBe(0);
		expect(calls).toContain("serve");
	});

	test("service install invokes installService", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["service", "install"], deps)).toBe(0);
		expect(calls).toContain("install");
	});

	for (const action of ["start", "stop", "restart", "status"]) {
		test(`service ${action} calls systemctl --user ${action} web-spider.service`, async () => {
			const { deps, calls } = fakeDeps();
			expect(await runCli(["service", action], deps)).toBe(0);
			expect(calls).toContain(`systemctl:${action} web-spider.service`);
		});
	}

	test("unknown command prints usage and returns exit code 2", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("unknown service action prints usage and returns exit code 2", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["service", "bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});
});

describe("runCli fetch — CLI parity for the fetch/crawl operations", () => {
	test("plain fetch (no --depth) calls the fetch operation with the url", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X", markdown: "body", cache: "miss" }) });
		expect(await runCli(["fetch", "https://x.test"], deps)).toBe(0);
		expect(operations).toEqual([{ op: "fetch", input: expect.objectContaining({ url: "https://x.test" }) }]);
	});

	test("--depth > 0 routes to the crawl operation instead", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 2, pages: [] }) });
		expect(await runCli(["fetch", "https://x.test", "--depth", "2", "--max-pages", "5"], deps)).toBe(0);
		expect(operations[0]?.op).toBe("crawl");
		expect(operations[0]?.input).toMatchObject({ url: "https://x.test", depth: 2, maxPages: 5 });
	});

	test("--no-same-domain sets sameDomain:false on the crawl operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1", "--no-same-domain"], deps);
		expect(operations[0]?.input).toMatchObject({ sameDomain: false });
	});

	test("--format/--query/--enhanced/--token-budget/--path/--top-n are all forwarded", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ tag: "code", path: "a.b", text: "x" }) });
		await runCli(["fetch", "https://x.test", "--format", "tree", "--path", "a.b", "--top-n", "3", "--enhanced", "--token-budget", "500"], deps);
		expect(operations[0]?.input).toMatchObject({ format: "tree", path: "a.b", topN: 3, enhanced: true, tokenBudget: 500 });
	});

	test("--json prints the raw operation result verbatim", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--json"], deps);
		expect(calls).toEqual([`stdout:${JSON.stringify({ url: "https://x.test", title: "X" })}`]);
	});

	test("without --json, a human-readable summary is printed instead of raw JSON", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X Article", markdown: "hello", wordCount: 1, cache: "miss" }) });
		await runCli(["fetch", "https://x.test"], deps);
		expect(calls[0]).toContain("X Article");
		expect(calls[0]).not.toBe(JSON.stringify({ url: "https://x.test" }));
	});

	test("missing url prints usage and returns exit code 2", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["fetch"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("an invalid numeric flag prints usage and returns exit code 2", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["fetch", "https://x.test", "--depth", "not-a-number"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("a client/daemon error is reported to stderr with exit code 1, not thrown", async () => {
		const { deps, calls } = fakeDeps({ call: () => { throw new Error("Web Spider daemon is not running; install or start web-spider.service"); } });
		expect(await runCli(["fetch", "https://x.test"], deps)).toBe(1);
		expect(calls).toEqual(["stderr:Web Spider daemon is not running; install or start web-spider.service"]);
	});
});

describe("runCli search", () => {
	test("forwards query and flags to the search operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ query: "q", results: [] }) });
		await runCli(["search", "rate limiting", "--num-results", "5", "--engine", "ddg", "--time-range", "month"], deps);
		expect(operations).toEqual([{ op: "search", input: expect.objectContaining({ query: "rate limiting", numResults: 5, searchEngine: "ddg", timeRange: "month" }) }]);
	});

	test("missing query prints usage and returns exit code 2", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["search"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("human output lists result titles and urls", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ query: "q", results: [{ url: "https://r.test", title: "R", snippet: "s" }] }) });
		await runCli(["search", "q"], deps);
		expect(calls[0]).toContain("R");
		expect(calls[0]).toContain("https://r.test");
	});
});

describe("runCli cache list/search", () => {
	test("cache list forwards grep/offset/limit", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] }) });
		await runCli(["cache", "list", "--grep", "docs", "--limit", "5"], deps);
		expect(operations).toEqual([{ op: "cache.list", input: expect.objectContaining({ grep: "docs", limit: 5 }) }]);
	});

	test("cache list human output reports an empty cache clearly", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] }) });
		await runCli(["cache", "list"], deps);
		expect(calls).toEqual(["stdout:No cached pages."]);
	});

	test("cache search requires a query", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["cache", "search"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("cache search forwards query and limit", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ query: "q", pagesSearched: 0, hits: [] }) });
		await runCli(["cache", "search", "q", "--limit", "3"], deps);
		expect(operations).toEqual([{ op: "cache.search", input: expect.objectContaining({ query: "q", limit: 3 }) }]);
	});

	test("unknown cache subcommand prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["cache", "bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});
});

describe("runCli papyrus ingest", () => {
	test("forwards urls as kind:pages and an optional --relates-to", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ ingested: [{ url: "https://x.test", docId: "doc-1" }], skipped: [] }) });
		await runCli(["papyrus", "ingest", "https://x.test", "--relates-to", "task-123"], deps);
		expect(operations).toEqual([{ op: "papyrus.ingest", input: { kind: "pages", urls: ["https://x.test"], relatesTo: "task-123" } }]);
	});

	test("supports multiple urls in one call", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ ingested: [], skipped: [] }) });
		await runCli(["papyrus", "ingest", "https://a.test", "https://b.test"], deps);
		expect((operations[0]?.input as { urls: string[] }).urls).toEqual(["https://a.test", "https://b.test"]);
	});

	test("missing url prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["papyrus", "ingest"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("unknown papyrus subcommand prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["papyrus", "bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("human output reports ingested and skipped urls", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ ingested: [{ url: "https://x.test", docId: "doc-1" }], skipped: [{ url: "https://y.test", reason: "not cached — fetch it first, then ingest" }] }) });
		await runCli(["papyrus", "ingest", "https://x.test", "https://y.test"], deps);
		expect(calls[0]).toContain("doc-1");
		expect(calls[0]).toContain("not cached");
	});

	test("a Papyrus-unreachable error is reported to stderr with exit code 1", async () => {
		const { deps, calls } = fakeDeps({ call: () => { throw new Error("Papyrus daemon is not running; install/start papyrus.service"); } });
		expect(await runCli(["papyrus", "ingest", "https://x.test"], deps)).toBe(1);
		expect(calls).toEqual(["stderr:Papyrus daemon is not running; install/start papyrus.service"]);
	});
});
