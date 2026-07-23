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
		readEvalScript: () => "1+1",
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

	test("--ignore-robots is forwarded as true; omitted entirely by default", async () => {
		const { deps: withFlag, operations: withFlagOps } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--ignore-robots"], withFlag);
		expect(withFlagOps[0]?.input).toMatchObject({ ignoreRobots: true });

		const { deps: withoutFlag, operations: withoutFlagOps } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test"], withoutFlag);
		expect((withoutFlagOps[0]?.input as { ignoreRobots?: boolean }).ignoreRobots).toBeUndefined();
	});

	test("--ignore-robots also forwards to a crawl (depth > 0), same shared flag", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 0, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1", "--ignore-robots"], deps);
		expect(operations).toEqual([{ op: "crawl", input: expect.objectContaining({ ignoreRobots: true }) }]);
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

describe("runCli session create/list/close", () => {
	test("create forwards the name and forceChromeChannel:undefined by default", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "agent1", createdAt: 1, lastActivityAt: 1, snapshotVersion: 0, closed: false }) });
		await runCli(["session", "create", "agent1"], deps);
		expect(operations).toEqual([{ op: "session.create", input: { name: "agent1", forceChromeChannel: undefined } }]);
	});

	test("create forwards forceChromeChannel:true with --force-chrome-channel", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "agent1", createdAt: 1, lastActivityAt: 1, snapshotVersion: 0, closed: false }) });
		await runCli(["session", "create", "agent1", "--force-chrome-channel"], deps);
		expect((operations[0]?.input as { forceChromeChannel: boolean }).forceChromeChannel).toBe(true);
	});

	test("create missing name prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "create"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("list calls session.list with no input and reports an empty registry clearly", async () => {
		const { deps, calls, operations } = fakeDeps({ call: () => ({ sessions: [] }) });
		await runCli(["session", "list"], deps);
		expect(operations).toEqual([{ op: "session.list", input: {} }]);
		expect(calls[0]).toContain("No active sessions");
	});

	test("close forwards the name and reports success", async () => {
		const { deps, calls, operations } = fakeDeps({ call: () => ({ name: "agent1", closed: true }) });
		await runCli(["session", "close", "agent1"], deps);
		expect(operations).toEqual([{ op: "session.close", input: { name: "agent1" } }]);
		expect(calls[0]).toContain("closed");
	});

	test("close missing name prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "close"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("unknown session subcommand prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});
});

describe("runCli session act", () => {
	test("navigate forwards url/snapshotVersion/action, with no script/text/select fields at all", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "navigate", snapshotVersion: 1 }) });
		await runCli(["session", "act", "a", "--action", "navigate", "--snapshot-version", "0", "--url", "https://x.test"], deps);
		expect(operations).toEqual([{ op: "session.act", input: { name: "a", action: "navigate", snapshotVersion: 0, timeoutMs: undefined, url: "https://x.test", selector: undefined, script: undefined, text: undefined, clear: undefined, value: undefined, label: undefined, loadState: undefined, state: undefined } }]);
	});

	test("click forwards the selector", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "click", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "click", "--snapshot-version", "0", "--selector", "#go"], deps);
		expect((operations[0]?.input as { selector: string }).selector).toBe("#go");
	});

	test("type forwards selector/text, clear defaults to undefined (server-side default true)", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "type", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "type", "--snapshot-version", "0", "--selector", "#search", "--text", "E2"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#search", text: "E2", clear: undefined });
	});

	test("type with --no-clear forwards clear:false", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "type", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "type", "--snapshot-version", "0", "--selector", "#search", "--text", "E2", "--no-clear"], deps);
		expect(operations[0]?.input).toMatchObject({ clear: false });
	});

	test("select forwards selector/value", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "select", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "select", "--snapshot-version", "0", "--selector", "#wg", "--value", "wg3"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#wg", value: "wg3", label: undefined });
	});

	test("select forwards selector/label", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "select", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "select", "--snapshot-version", "0", "--selector", "#wg", "--label", "WG3"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#wg", value: undefined, label: "WG3" });
	});

	test("waitFor forwards selector", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "waitFor", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "waitFor", "--snapshot-version", "0", "--selector", "#results"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#results", text: undefined, loadState: undefined });
	});

	test("waitFor forwards --load-state and --state", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "waitFor", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "waitFor", "--snapshot-version", "0", "--selector", "#x", "--state", "hidden"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#x", state: "hidden" });

		await runCli(["session", "act", "a", "--action", "waitFor", "--snapshot-version", "0", "--load-state", "networkidle"], deps);
		expect(operations[1]?.input).toMatchObject({ loadState: "networkidle" });
	});

	test("queryText forwards the selector; human output prints the result", async () => {
		const { deps, operations, calls } = fakeDeps({ call: () => ({ name: "a", action: "queryText", snapshotVersion: 0, result: ["foo", "bar"] }) });
		await runCli(["session", "act", "a", "--action", "queryText", "--snapshot-version", "0", "--selector", "li"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "li" });
		expect(calls.some((c) => c.includes('["foo","bar"]'))).toBe(true);
	});

	test("readTable forwards the selector; human output prints the result", async () => {
		const { deps, operations, calls } = fakeDeps({ call: () => ({ name: "a", action: "readTable", snapshotVersion: 0, result: [["a", "b"]] }) });
		await runCli(["session", "act", "a", "--action", "readTable", "--snapshot-version", "0", "--selector", "table"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "table" });
		expect(calls.some((c) => c.includes('[["a","b"]]'))).toBe(true);
	});

	test("snapshot forwards selector/depth/boxes/mode; human output prints the result", async () => {
		const { deps, operations, calls } = fakeDeps({ call: () => ({ name: "a", action: "snapshot", snapshotVersion: 0, result: '- heading "Title"' }) });
		await runCli(["session", "act", "a", "--action", "snapshot", "--snapshot-version", "0", "--selector", "nav", "--depth", "2", "--boxes", "--mode", "ai"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "nav", depth: 2, boxes: true, mode: "ai" });
		expect(calls.some((c) => c.includes('heading \\"Title\\"'))).toBe(true);
	});

	test("snapshot with no options forwards undefined depth/boxes/mode", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "snapshot", snapshotVersion: 0, result: "" }) });
		await runCli(["session", "act", "a", "--action", "snapshot", "--snapshot-version", "0"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: undefined, depth: undefined, boxes: undefined, mode: undefined });
	});

	test("a non-numeric --depth prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "act", "a", "--action", "snapshot", "--snapshot-version", "0", "--depth", "nope"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("eval reads the script via deps.readEvalScript(scriptFile), never as a plain --script flag", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "eval", snapshotVersion: 0, result: 42 }), readEvalScript: (file) => `script-from:${file}` });
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0", "--script-file", "/tmp/s.js"], deps);
		expect((operations[0]?.input as { script: string }).script).toBe("script-from:/tmp/s.js");
	});

	test("eval with no --script-file reads from stdin via deps.readEvalScript(undefined)", async () => {
		let seenArg: string | undefined = "unset";
		const { deps } = fakeDeps({
			call: () => ({ name: "a", action: "eval", snapshotVersion: 0 }),
			readEvalScript: (file) => { seenArg = file; return "1+1"; },
		});
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0"], deps);
		expect(seenArg).toBeUndefined();
	});

	test("screenshot requires no url/selector/script", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "screenshot", snapshotVersion: 0, screenshotBase64: "aGk=" }) });
		await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "0"], deps);
		expect(operations).toHaveLength(1);
	});

	test("an invalid --action prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "act", "a", "--action", "bogus", "--snapshot-version", "0"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("a missing --snapshot-version prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "act", "a", "--action", "screenshot"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("a non-numeric --snapshot-version prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "nope"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("a stale-snapshot rejection from the daemon is reported to stderr with exit code 1", async () => {
		const { deps, calls } = fakeDeps({ call: () => { throw new Error('session "a" snapshot version mismatch: caller supplied 0, current is 1'); } });
		expect(await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "0"], deps)).toBe(1);
		expect(calls).toEqual(["stderr:session \"a\" snapshot version mismatch: caller supplied 0, current is 1"]);
	});

	test("human output for eval includes the result; for screenshot includes only a byte-length hint, never the image data", async () => {
		const { deps: evalDeps, calls: evalCalls } = fakeDeps({ call: () => ({ name: "a", action: "eval", snapshotVersion: 0, result: { ok: true } }) });
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0"], evalDeps);
		expect(evalCalls[0]).toContain('{"ok":true}');

		const { deps: shotDeps, calls: shotCalls } = fakeDeps({ call: () => ({ name: "a", action: "screenshot", snapshotVersion: 0, screenshotBase64: "aGVsbG8=" }) });
		await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "0"], shotDeps);
		expect(shotCalls[0]).not.toContain("aGVsbG8=");
		expect(shotCalls[0]).toContain("base64 characters");
	});
});
