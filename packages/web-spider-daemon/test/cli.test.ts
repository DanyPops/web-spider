import { describe, expect, test } from "bun:test";
import { type CliDependencies, runCli, webSpiderServiceSpec } from "../src/cli.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "../src/service.ts";

interface RecordedCall {
	op: OperationName;
	input: unknown;
}

function fakeDeps(
	overrides: {
		call?: (op: OperationName, input: unknown) => unknown;
	} & Partial<Omit<CliDependencies, "client">> = {},
): { deps: CliDependencies; calls: string[]; operations: RecordedCall[] } {
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
		service: {
			unitName: "armada-web-spider.service",
			install: () => {
				calls.push("service:install");
				return { installed: true };
			},
			action: (action) => calls.push(`service:${action}:armada-web-spider.service`),
		},
		legacyService: {
			stopForCutover: () => {
				calls.push("legacy:stop");
				return true;
			},
			restore: () => calls.push("legacy:restore"),
			remove: () => calls.push("legacy:remove"),
		},
		serve: () => {
			calls.push("serve");
		},
		readEvalScript: () => "1+1",
		...overrides,
	};
	return { deps, calls, operations };
}

describe("webSpiderServiceSpec — Armada registration", () => {
	test("declares the Armada-owned vehicle with required hardening and no environment material", () => {
		const spec = webSpiderServiceSpec({
			bunBin: "/usr/bin/bun",
			cliPath: "/opt/web-spider/cli.ts",
			handlePath: "/run/web-spider/daemon.json",
		});
		expect(spec).toMatchObject({
			name: "web-spider",
			binPath: "/usr/bin/bun",
			args: ["/opt/web-spider/cli.ts", "serve"],
			handlePath: "/run/web-spider/daemon.json",
			restartOnFailure: true,
			restartSec: 2,
			noNewPrivileges: true,
			privateTmp: true,
			waitForNetwork: true,
		});
		expect(spec.env).toBeUndefined();
		expect(JSON.stringify(spec)).not.toContain("API_KEY");
		expect(JSON.stringify(spec)).not.toContain("ENIGMA_CLIENT_TOKEN");
	});
});

describe("runCli — serve / service (unchanged surface)", () => {
	test("serve invokes the serve dependency", async () => {
		const { deps, calls } = fakeDeps();
		const code = await runCli(["serve"], deps);
		expect(code).toBe(0);
		expect(calls).toContain("serve");
	});

	test("service install stops the legacy unit, waits for Armada registration, then removes the legacy descriptor", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["service", "install"], deps)).toBe(0);
		expect(calls).toEqual(["legacy:stop", "service:install", "legacy:remove"]);
	});

	test("service install reports an Armada registration failure without attempting restart", async () => {
		const { deps, calls } = fakeDeps({
			service: {
				unitName: "armada-web-spider.service",
				install: () => ({ installed: false, reason: "unsupported runtime requirement" }),
				action: () => {
					throw new Error("restart should not be called");
				},
			},
		});
		await expect(runCli(["service", "install"], deps)).rejects.toThrow("failed to install the Web Spider service");
		expect(calls).toEqual(["legacy:stop", "legacy:restore"]);
	});

	for (const action of ["start", "stop", "restart", "status"]) {
		test(`service ${action} uses the shared service boundary for armada-web-spider.service`, async () => {
			const { deps, calls } = fakeDeps();
			expect(await runCli(["service", action], deps)).toBe(0);
			expect(calls).toContain(`service:${action}:armada-web-spider.service`);
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
		await runCli(
			["fetch", "https://x.test", "--format", "tree", "--path", "a.b", "--top-n", "3", "--enhanced", "--token-budget", "500"],
			deps,
		);
		expect(operations[0]?.input).toMatchObject({ format: "tree", path: "a.b", topN: 3, enhanced: true, tokenBudget: 500 });
	});

	test("--pdf-page-start/--pdf-page-end forward the bounded PDF range", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test/report.pdf", markdown: "--- Page 2 ---" }) });
		await runCli(["fetch", "https://x.test/report.pdf", "--pdf-page-start", "2", "--pdf-page-end", "4"], deps);
		expect(operations[0]?.input).toMatchObject({ pdfPageStart: 2, pdfPageEnd: 4 });
	});

	test("--discover-only/--crawl-urls/--max-total-chars/--deadline-ms are all forwarded to the crawl operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 2, pages: [] }) });
		await runCli(
			[
				"fetch",
				"https://x.test",
				"--crawl-urls",
				"https://x.test/a,https://x.test/b",
				"--discover-only",
				"--max-total-chars",
				"5000",
				"--deadline-ms",
				"30000",
			],
			deps,
		);
		expect(operations[0]?.op).toBe("crawl");
		expect(operations[0]?.input).toMatchObject({
			crawlUrls: ["https://x.test/a", "https://x.test/b"],
			discoverOnly: true,
			maxTotalChars: 5000,
			deadlineMs: 30000,
		});
	});

	test("--crawl-urls alone (no --depth) still routes to the crawl operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--crawl-urls", "https://x.test/a"], deps);
		expect(operations[0]?.op).toBe("crawl");
	});

	test("--sources forwards a parsed name list to fetch, and to crawl", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--sources", "github,mediawiki"], deps);
		expect(operations[0]?.input).toMatchObject({ sources: ["github", "mediawiki"] });

		const { deps: crawlDeps, operations: crawlOps } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1", "--sources", "youtube"], crawlDeps);
		expect(crawlOps[0]?.op).toBe("crawl");
		expect(crawlOps[0]?.input).toMatchObject({ sources: ["youtube"] });
	});

	test("--sources is omitted entirely when not given", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test"], deps);
		expect((operations[0]!.input as { sources?: string[] }).sources).toBeUndefined();
	});

	test("--exclude-domains and --include-domains forward parsed name lists to crawl only", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(
			["fetch", "https://x.test", "--depth", "1", "--exclude-domains", "ads.example,tracker.example", "--include-domains", "x.test"],
			deps,
		);
		expect(operations[0]?.op).toBe("crawl");
		expect(operations[0]?.input).toMatchObject({
			excludeDomains: ["ads.example", "tracker.example"],
			includeDomains: ["x.test"],
		});
	});

	test("--exclude-domains/--include-domains are omitted entirely when not given", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1"], deps);
		const input = operations[0]!.input as { excludeDomains?: string[]; includeDomains?: string[] };
		expect(input.excludeDomains).toBeUndefined();
		expect(input.includeDomains).toBeUndefined();
	});

	test("--max-cache-age-ms forwards a parsed number to fetch, crawl, and quotes", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--max-cache-age-ms", "1000"], deps);
		expect(operations[0]?.input).toMatchObject({ maxCacheAgeMs: 1000 });

		const { deps: crawlDeps, operations: crawlOps } = fakeDeps({ call: () => ({ pagesFound: 1, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1", "--max-cache-age-ms", "0"], crawlDeps);
		expect(crawlOps[0]?.op).toBe("crawl");
		expect(crawlOps[0]?.input).toMatchObject({ maxCacheAgeMs: 0 });

		const { deps: quotesDeps, operations: quotesOps } = fakeDeps({ call: () => ({ resources: [] }) });
		await runCli(["quotes", "q", "--urls", "https://x.test", "--max-cache-age-ms", "5000"], quotesDeps);
		expect(quotesOps[0]?.input).toMatchObject({ maxCacheAgeMs: 5000 });
	});

	test("--max-cache-age-ms is omitted entirely when not given", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test"], deps);
		expect((operations[0]!.input as { maxCacheAgeMs?: number }).maxCacheAgeMs).toBeUndefined();
	});

	test("--ignore-robots is forwarded as true; omitted entirely by default", async () => {
		const { deps: withFlag, operations: withFlagOps } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--ignore-robots"], withFlag);
		expect(withFlagOps[0]?.input).toMatchObject({ ignoreRobots: true });

		const { deps: withoutFlag, operations: withoutFlagOps } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test"], withoutFlag);
		expect((withoutFlagOps[0]!.input as { ignoreRobots?: boolean }).ignoreRobots).toBeUndefined();
	});

	test("--ignore-robots also forwards to a crawl (depth > 0), same shared flag", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ pagesFound: 0, pages: [] }) });
		await runCli(["fetch", "https://x.test", "--depth", "1", "--ignore-robots"], deps);
		expect(operations).toEqual([{ op: "crawl", input: expect.objectContaining({ ignoreRobots: true }) }]);
	});

	test("--format source forwards the normalized-source request and --json prints its completeness contract verbatim", async () => {
		const output = {
			url: "https://x.test/data.json",
			contentType: "application/json",
			content: '{\n  "ok": true\n}',
			complete: true,
			truncated: false,
			cache: "miss",
		};
		const { deps, calls, operations } = fakeDeps({ call: () => output });
		await runCli(["fetch", "https://x.test/data.json", "--format", "source", "--json"], deps);
		expect(operations[0]).toEqual({ op: "fetch", input: expect.objectContaining({ format: "source" }) });
		expect(calls).toEqual([`stdout:${JSON.stringify(output)}`]);
	});

	test("--json prints the raw operation result verbatim", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ url: "https://x.test", title: "X" }) });
		await runCli(["fetch", "https://x.test", "--json"], deps);
		expect(calls).toEqual([`stdout:${JSON.stringify({ url: "https://x.test", title: "X" })}`]);
	});

	test("without --json, a human-readable summary is printed instead of raw JSON", async () => {
		const { deps, calls } = fakeDeps({
			call: () => ({ url: "https://x.test", title: "X Article", markdown: "hello", wordCount: 1, cache: "miss" }),
		});
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
		const { deps, calls } = fakeDeps({
			call: () => {
				throw new Error("Web Spider daemon is not running; install or start armada-web-spider.service");
			},
		});
		expect(await runCli(["fetch", "https://x.test"], deps)).toBe(1);
		expect(calls).toEqual(["stderr:Web Spider daemon is not running; install or start armada-web-spider.service"]);
	});
});

describe("runCli search", () => {
	test("forwards query and flags to the search operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ query: "q", results: [] }) });
		await runCli(["search", "rate limiting", "--num-results", "5", "--engine", "serper", "--time-range", "month"], deps);
		expect(operations).toEqual([
			{
				op: "search",
				input: expect.objectContaining({ query: "rate limiting", numResults: 5, searchEngine: "serper", timeRange: "month" }),
			},
		]);
	});

	test("forwards --site-filter to the search operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ query: "q", results: [] }) });
		await runCli(["search", "best pizza", "--site-filter", "reddit.com"], deps);
		expect(operations).toEqual([{ op: "search", input: expect.objectContaining({ query: "best pizza", siteFilter: "reddit.com" }) }]);
	});

	test("forwards --full-content as wantFullContent:true; omitted entirely when not passed", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ query: "q", results: [] }) });
		await runCli(["search", "deep dive topic", "--full-content"], deps);
		expect(operations).toEqual([{ op: "search", input: expect.objectContaining({ query: "deep dive topic", wantFullContent: true }) }]);

		operations.length = 0;
		await runCli(["search", "plain query"], deps);
		expect((operations[0]?.input as { wantFullContent?: boolean } | undefined)?.wantFullContent).toBeUndefined();
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

describe("runCli usage", () => {
	test("forwards engine and limit flags to the search.usage operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ entries: [] }) });
		await runCli(["usage", "--engine", "brave", "--limit", "10"], deps);
		expect(operations).toEqual([{ op: "search.usage", input: expect.objectContaining({ engine: "brave", limit: 10 }) }]);
	});

	test("human output reports no usage recorded yet when empty", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ entries: [] }) });
		await runCli(["usage"], deps);
		expect(calls[0]).toContain("No search usage recorded");
	});

	test("human output lists engine and credits/cost for each entry", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ entries: [{ engine: "tavily", observedAt: 0, credits: 2 }] }) });
		await runCli(["usage"], deps);
		expect(calls[0]).toContain("tavily");
		expect(calls[0]).toContain("credits=2");
	});
});

describe("runCli daemon diagnose", () => {
	test("forwards historyLimit to the daemon.diagnose operation", async () => {
		const { deps, operations } = fakeDeps({
			call: () => ({ instanceId: "i1", pid: 1, startedAt: "2026-01-01T00:00:00.000Z", provenance: "unknown", history: [] }),
		});
		await runCli(["daemon", "diagnose", "--history-limit", "5"], deps);
		expect(operations).toEqual([{ op: "daemon.diagnose", input: { historyLimit: 5 } }]);
	});

	test("human output reports identity and no recorded restart history yet when empty", async () => {
		const { deps, calls } = fakeDeps({
			call: () => ({ instanceId: "i1", pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", provenance: "service", history: [] }),
		});
		await runCli(["daemon", "diagnose"], deps);
		expect(calls[0]).toContain("i1");
		expect(calls[0]).toContain("4242");
		expect(calls[0]).toContain("No recorded restart history");
	});

	test("human output lists each history event", async () => {
		const { deps, calls } = fakeDeps({
			call: () => ({
				instanceId: "i2",
				pid: 1,
				startedAt: "2026-01-01T00:00:00.000Z",
				provenance: "unknown",
				history: [{ instanceId: "i1", pid: 1, type: "stopped", at: "2026-01-01T00:01:00.000Z", provenance: "unknown", reason: "SIGTERM" }],
			}),
		});
		await runCli(["daemon", "diagnose"], deps);
		expect(calls[0]).toContain("stopped");
		expect(calls[0]).toContain("SIGTERM");
	});
});

describe("runCli search-key test", () => {
	test("forwards the engine to the search.testKeys operation", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ engine: "brave", results: [] }) });
		await runCli(["search-key", "test", "brave"], deps);
		expect(operations).toEqual([{ op: "search.testKeys", input: expect.objectContaining({ engine: "brave" }) }]);
	});

	test("missing engine prints a one-line usage message and returns exit code 1", async () => {
		const { deps, calls } = fakeDeps();
		expect(await runCli(["search-key", "test"], deps)).toBe(1);
		expect(calls.some((c) => c.startsWith("stderr:usage: web-spider search-key test"))).toBe(true);
	});

	test("human output reports each key's index and status, never a raw key", async () => {
		const { deps, calls } = fakeDeps({
			call: () => ({
				engine: "tavily",
				results: [
					{ index: 0, status: "valid" },
					{ index: 1, status: "invalid" },
				],
			}),
		});
		await runCli(["search-key", "test", "tavily"], deps);
		expect(calls[0]).toContain("tavily");
		expect(calls[0]).toContain("#0");
		expect(calls[0]).toContain("valid");
		expect(calls[0]).toContain("#1");
		expect(calls[0]).toContain("invalid");
	});

	test("human output reports nothing stored when the results array is empty", async () => {
		const { deps, calls } = fakeDeps({ call: () => ({ engine: "brave", results: [] }) });
		await runCli(["search-key", "test", "brave"], deps);
		expect(calls[0]).toContain("no search keys stored");
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

describe("runCli session create/list/close", () => {
	test("create keeps headed and forceChromeChannel undefined by default", async () => {
		const { deps, operations } = fakeDeps({
			call: () => ({ name: "agent1", createdAt: 1, lastActivityAt: 1, snapshotVersion: 0, closed: false }),
		});
		await runCli(["session", "create", "agent1"], deps);
		expect(operations).toEqual([{ op: "session.create", input: { name: "agent1", forceChromeChannel: undefined, headed: undefined } }]);
	});

	test("create forwards headed and forceChromeChannel when requested for human takeover", async () => {
		const { deps, operations } = fakeDeps({
			call: () => ({ name: "agent1", createdAt: 1, lastActivityAt: 1, snapshotVersion: 0, closed: false }),
		});
		await runCli(["session", "create", "agent1", "--headed", "--force-chrome-channel"], deps);
		expect(operations[0]!.input).toMatchObject({ headed: true, forceChromeChannel: true });
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
		expect(operations).toEqual([
			{
				op: "session.act",
				input: {
					name: "a",
					action: "navigate",
					snapshotVersion: 0,
					timeoutMs: undefined,
					url: "https://x.test",
					selector: undefined,
					script: undefined,
					text: undefined,
					clear: undefined,
					value: undefined,
					label: undefined,
					loadState: undefined,
					state: undefined,
				},
			},
		]);
	});

	test("click forwards the selector", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "click", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "click", "--snapshot-version", "0", "--selector", "#go"], deps);
		expect((operations[0]!.input as { selector: string }).selector).toBe("#go");
	});

	test("hover forwards the selector", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "hover", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "hover", "--snapshot-version", "0", "--selector", "#menu"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#menu" });
	});

	test("pressKey forwards --key, with an optional --selector", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "pressKey", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "pressKey", "--snapshot-version", "0", "--key", "Enter"], deps);
		expect(operations[0]?.input).toMatchObject({ key: "Enter", selector: undefined });

		await runCli(
			["session", "act", "a", "--action", "pressKey", "--snapshot-version", "0", "--key", "Escape", "--selector", "#modal"],
			deps,
		);
		expect(operations[1]?.input).toMatchObject({ key: "Escape", selector: "#modal" });
	});

	test("type forwards selector/text, clear defaults to undefined (server-side default true)", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "type", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "type", "--snapshot-version", "0", "--selector", "#search", "--text", "E2"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "#search", text: "E2", clear: undefined });
	});

	test("type with --no-clear forwards clear:false", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "type", snapshotVersion: 0 }) });
		await runCli(
			["session", "act", "a", "--action", "type", "--snapshot-version", "0", "--selector", "#search", "--text", "E2", "--no-clear"],
			deps,
		);
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
		const { deps, operations, calls } = fakeDeps({
			call: () => ({ name: "a", action: "queryText", snapshotVersion: 0, result: ["foo", "bar"] }),
		});
		await runCli(["session", "act", "a", "--action", "queryText", "--snapshot-version", "0", "--selector", "li"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "li" });
		expect(calls.some((c) => c.includes('["foo","bar"]'))).toBe(true);
	});

	test("readTable forwards the selector; human output prints the result", async () => {
		const { deps, operations, calls } = fakeDeps({
			call: () => ({ name: "a", action: "readTable", snapshotVersion: 0, result: [["a", "b"]] }),
		});
		await runCli(["session", "act", "a", "--action", "readTable", "--snapshot-version", "0", "--selector", "table"], deps);
		expect(operations[0]?.input).toMatchObject({ selector: "table" });
		expect(calls.some((c) => c.includes('[["a","b"]]'))).toBe(true);
	});

	test("snapshot forwards selector/depth/boxes/mode; human output prints the result", async () => {
		const { deps, operations, calls } = fakeDeps({
			call: () => ({ name: "a", action: "snapshot", snapshotVersion: 0, result: '- heading "Title"' }),
		});
		await runCli(
			[
				"session",
				"act",
				"a",
				"--action",
				"snapshot",
				"--snapshot-version",
				"0",
				"--selector",
				"nav",
				"--depth",
				"2",
				"--boxes",
				"--mode",
				"ai",
			],
			deps,
		);
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

	test("handleDialog forwards --accept and --prompt-text", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "handleDialog", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "handleDialog", "--snapshot-version", "0", "--accept", "--prompt-text", "E2"], deps);
		expect(operations[0]?.input).toMatchObject({ accept: true, promptText: "E2" });
	});

	test("handleDialog forwards --dismiss as accept:false", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "handleDialog", snapshotVersion: 0 }) });
		await runCli(["session", "act", "a", "--action", "handleDialog", "--snapshot-version", "0", "--dismiss"], deps);
		expect(operations[0]?.input).toMatchObject({ accept: false });
	});

	test("handleDialog with both --accept and --dismiss prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(
			await runCli(["session", "act", "a", "--action", "handleDialog", "--snapshot-version", "0", "--accept", "--dismiss"], deps),
		).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("downloads requires no extra flags; human output prints the result", async () => {
		const record = { filename: "spec.pdf", path: "/tmp/spec.pdf", url: "https://x.test/spec.pdf", failure: null };
		const { deps, operations, calls } = fakeDeps({
			call: () => ({ name: "a", action: "downloads", snapshotVersion: 0, result: [record] }),
		});
		await runCli(["session", "act", "a", "--action", "downloads", "--snapshot-version", "0"], deps);
		expect(operations).toHaveLength(1);
		expect(calls.some((c) => c.includes("spec.pdf"))).toBe(true);
	});

	test("consoleMessages requires no extra flags", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "consoleMessages", snapshotVersion: 0, result: [] }) });
		await runCli(["session", "act", "a", "--action", "consoleMessages", "--snapshot-version", "0"], deps);
		expect(operations).toHaveLength(1);
	});

	test("networkRequests forwards --include-static", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "networkRequests", snapshotVersion: 0, result: [] }) });
		await runCli(["session", "act", "a", "--action", "networkRequests", "--snapshot-version", "0"], deps);
		expect(operations[0]?.input).toMatchObject({ includeStatic: undefined });

		await runCli(["session", "act", "a", "--action", "networkRequests", "--snapshot-version", "0", "--include-static"], deps);
		expect(operations[1]?.input).toMatchObject({ includeStatic: true });
	});

	test("tabs forwards --tab-operation and --tab-index", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "tabs", snapshotVersion: 0, result: [] }) });
		await runCli(
			["session", "act", "a", "--action", "tabs", "--snapshot-version", "0", "--tab-operation", "select", "--tab-index", "1"],
			deps,
		);
		expect(operations[0]?.input).toMatchObject({ tabOperation: "select", tabIndex: 1 });
	});

	test("tabs new forwards --url for the new tab", async () => {
		const { deps, operations } = fakeDeps({ call: () => ({ name: "a", action: "tabs", snapshotVersion: 0, result: {} }) });
		await runCli(
			["session", "act", "a", "--action", "tabs", "--snapshot-version", "0", "--tab-operation", "new", "--url", "https://x.test"],
			deps,
		);
		expect(operations[0]?.input).toMatchObject({ tabOperation: "new", url: "https://x.test" });
	});

	test("a non-numeric --tab-index prints usage", async () => {
		const { deps, calls } = fakeDeps();
		expect(
			await runCli(
				["session", "act", "a", "--action", "tabs", "--snapshot-version", "0", "--tab-operation", "select", "--tab-index", "nope"],
				deps,
			),
		).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("eval reads the script via deps.readEvalScript(scriptFile), never as a plain --script flag", async () => {
		const { deps, operations } = fakeDeps({
			call: () => ({ name: "a", action: "eval", snapshotVersion: 0, result: 42 }),
			readEvalScript: (file) => `script-from:${file}`,
		});
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0", "--script-file", "/tmp/s.js"], deps);
		expect((operations[0]!.input as { script: string }).script).toBe("script-from:/tmp/s.js");
	});

	test("eval with no --script-file reads from stdin via deps.readEvalScript(undefined)", async () => {
		let seenArg: string | undefined = "unset";
		const { deps } = fakeDeps({
			call: () => ({ name: "a", action: "eval", snapshotVersion: 0 }),
			readEvalScript: (file) => {
				seenArg = file;
				return "1+1";
			},
		});
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0"], deps);
		expect(seenArg).toBeUndefined();
	});

	test("screenshot requires no url/selector/script", async () => {
		const { deps, operations } = fakeDeps({
			call: () => ({ name: "a", action: "screenshot", snapshotVersion: 0, screenshotBase64: "aGk=" }),
		});
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
		const { deps, calls } = fakeDeps({
			call: () => {
				throw new Error('session "a" snapshot version mismatch: caller supplied 0, current is 1');
			},
		});
		expect(await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "0"], deps)).toBe(1);
		expect(calls).toEqual(['stderr:session "a" snapshot version mismatch: caller supplied 0, current is 1']);
	});

	test("human output for eval includes the result; for screenshot includes only a byte-length hint, never the image data", async () => {
		const { deps: evalDeps, calls: evalCalls } = fakeDeps({
			call: () => ({ name: "a", action: "eval", snapshotVersion: 0, result: { ok: true } }),
		});
		await runCli(["session", "act", "a", "--action", "eval", "--snapshot-version", "0"], evalDeps);
		expect(evalCalls[0]).toContain('{"ok":true}');

		const { deps: shotDeps, calls: shotCalls } = fakeDeps({
			call: () => ({ name: "a", action: "screenshot", snapshotVersion: 0, screenshotBase64: "aGVsbG8=" }),
		});
		await runCli(["session", "act", "a", "--action", "screenshot", "--snapshot-version", "0"], shotDeps);
		expect(shotCalls[0]).not.toContain("aGVsbG8=");
		expect(shotCalls[0]).toContain("base64 characters");
	});
});
