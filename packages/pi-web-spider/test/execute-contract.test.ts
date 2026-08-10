import { readFileSync } from "node:fs";
import { registerActivityBroker, unregisterActivityBroker } from "@danypops/vehicle-client-pi/activity-broker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import piFactory from "../src/index.js";
import { type IsolatedDaemonEnv, isolatedDaemonEnv } from "./daemon-isolation.js";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

interface ToolResult {
	content: Array<{ text: string }>;
	details: Record<string, unknown>;
}

let h: ExtensionHarness;
let isolated: IsolatedDaemonEnv;
let server: FixtureServer;

beforeAll(async () => {
	isolated = isolatedDaemonEnv("pi-web-spider-execute-contract-test-");
	server = await startFixtureServer();
	h = createExtensionHarness(piFactory, { cwd: "/tmp", env: isolated.env });
	await h.boot();
});

afterAll(async () => {
	await h.shutdown();
	await server.close();
	isolated.cleanup();
});

describe("stream hygiene: extension must not write to stdout or stderr", () => {
	it("boot produces no stdout/stderr leaks", () => {
		expect(h.leaks).toHaveLength(0);
	});
});

describe("execute() result and failure channels", () => {
	it("registers native call and result renderers", () => {
		const definition = h.tools.get("web_fetch")?.definition;
		expect(definition).toBeDefined();
		expect(typeof definition?.renderCall).toBe("function");
		expect(typeof definition?.renderResult).toBe("function");

		const quotesDefinition = h.tools.get("web_quotes")?.definition;
		expect(quotesDefinition).toBeDefined();
		expect(typeof quotesDefinition?.renderCall).toBe("function");
		expect(typeof quotesDefinition?.renderResult).toBe("function");
	});

	it("throws invalid URL failures through Pi's native error channel", async () => {
		await expect(h.invokeTool("web_fetch", { url: "ftp://not-supported.example.com" })).rejects.toThrow("Unsupported protocol");
	});

	it("preserves safe unreachable-host diagnostics through Pi's native error channel", async () => {
		const failure = await h
			.invokeTool("web_fetch", {
				url: "http://this-host-does-not-exist-pivi-test.invalid?token=top-secret",
				timeoutMs: 3000,
			})
			.catch((error) => error as Error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toContain("web_fetch failed");
		expect(failure.message).toContain("fetch-transport-failed");
		// Bun reports its stable ConnectionRefused code even for a reserved .invalid
		// host; the safe transport classification must still survive Vehicle and Pi.
		expect(failure.message).toContain("kind=connection");
		expect(failure.message).toContain("diagnostic=Remote endpoint unavailable");
		expect(failure.message).not.toContain("top-secret");
	});

	it("missing url returns a typed cache listing", async () => {
		const result = (await h.invokeTool("web_fetch", {})) as ToolResult;
		expect(result).toHaveProperty("content");
		const text = JSON.parse(result.content[0].text);
		expect(text).not.toHaveProperty("error");
		expect(text).toHaveProperty("total");
		expect(Array.isArray(text.pages)).toBe(true);
		expect(result.details).toMatchObject({ kind: "web", operation: "cache-list", cache: "listing" });
	});

	it("validates highlights query before attempting a fetch", async () => {
		await expect(
			h.invokeTool("web_fetch", {
				url: "http://127.0.0.1:1",
				format: "highlights",
			}),
		).rejects.toThrow("highlights format requires a query");
	});

	it("returns robots denial as a typed blocked outcome", async () => {
		// A real robots.txt served by the real (isolated) daemon's own RobotsCache
		// fetch — replaces mocking globalThis.fetch, which the daemon (a separate
		// process) never sees.
		server.set("/robots.txt", "User-agent: *\nDisallow: /private", "text/plain");
		server.set("/private", "<html><body><article><h1>Secret</h1><p>Should never be fetched.</p></article></body></html>");

		const result = (await h.invokeTool("web_fetch", { url: `${server.baseUrl}/private` })) as ToolResult;
		expect(JSON.parse(result.content[0].text)).toMatchObject({ blocked: true, reason: "robots.txt" });
		expect(result.details).toMatchObject({ kind: "web", status: "blocked", blockedBy: "robots.txt" });
	});

	it("returns normalized JSON source with public completeness metadata", async () => {
		server.set("/source.json", '{"answer":42,"nested":{"ok":true}}', "application/json");
		const result = (await h.invokeTool("web_fetch", {
			url: `${server.baseUrl}/source.json`,
			format: "source",
		})) as ToolResult;
		const payload = JSON.parse(result.content[0].text);
		expect(payload).toMatchObject({
			url: `${server.baseUrl}/source.json`,
			contentType: "application/json",
			complete: true,
			truncated: false,
		});
		expect(JSON.parse(payload.content)).toEqual({ answer: 42, nested: { ok: true } });
		expect(result.details).toMatchObject({ kind: "web", operation: "fetch", format: "source", complete: true, truncated: false });
	});

	it("forwards bounded PDF pages and preserves PDF/quality metadata through the Pi surface", async () => {
		const pdf = readFileSync(new URL("../../web-spider/test/fixtures/pdf/multi-page.pdf", import.meta.url));
		server.set("/report.bin", pdf, "application/octet-stream");
		const result = (await h.invokeTool("web_fetch", {
			url: `${server.baseUrl}/report.bin`,
			pdfPageStart: 2,
			pdfPageEnd: 3,
		})) as ToolResult;
		const payload = JSON.parse(result.content[0].text);
		expect(payload).toMatchObject({
			contentOk: true,
			pdf: { totalPages: 3, pageStart: 2, pageEnd: 3, truncated: true },
		});
		expect(payload.markdown).toContain("--- Page 2 ---");
		expect(payload.markdown).not.toContain("--- Page 1 ---");
		expect(payload.truncated).toBe(true);
		expect(result.details).toMatchObject({ format: "markdown", complete: false, truncated: true });
	});

	it("recovers a genuinely image-only PDF via the OCR fallback and preserves ocrPages/qualityScore through the Pi surface", async () => {
		const pdf = readFileSync(new URL("../../web-spider/test/fixtures/pdf/recoverable-scanned.pdf", import.meta.url));
		server.set("/scan.bin", pdf, "application/octet-stream");
		const result = (await h.invokeTool("web_fetch", { url: `${server.baseUrl}/scan.bin` })) as ToolResult;
		const payload = JSON.parse(result.content[0].text);
		expect(payload.contentOk).toBe(true);
		expect(payload.pdf).toMatchObject({ totalPages: 1, ocrPages: [1] });
		expect(payload.pdf.qualityScore).toBeGreaterThan(0.5);
		expect(payload.markdown).toContain("Recovered by OCR fallback");
	}, 30_000);

	it("marks token-budget-truncated JSON source incomplete through the Pi surface", async () => {
		server.set("/large-source.json", JSON.stringify({ value: "abcdefghijklmnopqrstuvwxyz" }), "application/json");
		const result = (await h.invokeTool("web_fetch", {
			url: `${server.baseUrl}/large-source.json`,
			format: "source",
			tokenBudget: 4,
		})) as ToolResult;
		const payload = JSON.parse(result.content[0].text);
		expect(payload).toMatchObject({ contentType: "application/json", complete: false, truncated: true });
		expect(() => JSON.parse(payload.content)).toThrow();
		expect(result.details).toMatchObject({ format: "source", complete: false, truncated: true });
	});

	// Runs last in this describe block deliberately -- it fetches real pages from
	// server.baseUrl without a robots.txt in place, which would otherwise warm the
	// daemon's per-origin robots cache as "unrestricted" ahead of the robots-denial
	// test above and mask it.
	it("cache listing filters by tag end to end (extension param -> daemon op -> SQLite)", async () => {
		server.set(
			"/rust-ptp",
			'<html><head><meta name="keywords" content="rust,ptp"></head><body><article><h1>Rust PTP</h1><p>Clock sync in Rust.</p></article></body></html>',
		);
		server.set(
			"/python",
			'<html><head><meta name="keywords" content="python"></head><body><article><h1>Python</h1><p>Not the same topic.</p></article></body></html>',
		);
		await h.invokeTool("web_fetch", { url: `${server.baseUrl}/rust-ptp` });
		await h.invokeTool("web_fetch", { url: `${server.baseUrl}/python` });

		const result = (await h.invokeTool("web_fetch", { tag: "ptp" })) as ToolResult;
		const text = JSON.parse(result.content[0].text);
		expect(text.pages).toHaveLength(1);
		expect(text.pages[0].url).toBe(`${server.baseUrl}/rust-ptp`);
	});

	it("cache.list/cache.search now route through the real Vehicle protocol -- Activity Broker fires for both", async () => {
		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			server.set(
				"/vehicle-cache-check",
				"<html><body><article><h1>Vehicle cache check</h1><p>Proving the swap.</p></article></body></html>",
			);
			await h.invokeTool("web_fetch", { url: `${server.baseUrl}/vehicle-cache-check` });

			await h.invokeTool("web_fetch", {});
			await h.invokeTool("web_fetch", { query: "Vehicle cache check" });

			const listEvents = events.filter((e) => e.refs.operation === "cache.list");
			const searchEvents = events.filter((e) => e.refs.operation === "cache.search");
			expect(listEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
			expect(searchEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
		} finally {
			unregisterActivityBroker();
		}
	});

	it("fetch and crawl now route through the real Vehicle protocol -- Activity Broker fires for both", async () => {
		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			server.set(
				"/vehicle-fetch-check",
				"<html><body><article><h1>Vehicle fetch check</h1><p>Proving the swap.</p></article></body></html>",
			);
			await h.invokeTool("web_fetch", { url: `${server.baseUrl}/vehicle-fetch-check` });
			await h.invokeTool("web_fetch", { url: `${server.baseUrl}/vehicle-fetch-check`, depth: 1, maxPages: 1 });

			const fetchEvents = events.filter((e) => e.refs.operation === "fetch");
			const crawlEvents = events.filter((e) => e.refs.operation === "crawl");
			expect(fetchEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
			expect(crawlEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
		} finally {
			unregisterActivityBroker();
		}
	});
});

describe("web_category: curated relevance categories, end to end", () => {
	it("assign/list/remove round-trip through the real daemon, with real overlap across two categories", async () => {
		server.set("/category-me", "<html><body><article><h1>Category me</h1><p>Something worth curating.</p></article></body></html>");
		await h.invokeTool("web_fetch", { url: `${server.baseUrl}/category-me` });

		const assignCode = (await h.invokeTool("web_category", {
			operation: "assign",
			url: `${server.baseUrl}/category-me`,
			category: "Code",
		})) as ToolResult;
		expect(JSON.parse(assignCode.content[0].text)).toMatchObject({ category: "Code" });

		const assignPtp = (await h.invokeTool("web_category", {
			operation: "assign",
			url: `${server.baseUrl}/category-me`,
			category: "PTP Protocol",
		})) as ToolResult;
		expect(JSON.parse(assignPtp.content[0].text)).toMatchObject({ category: "PTP Protocol" });

		const list = (await h.invokeTool("web_category", { operation: "list" })) as ToolResult;
		const categories = JSON.parse(list.content[0].text).categories;
		expect(categories.map((c: { name: string }) => c.name).sort()).toEqual(["Code", "PTP Protocol"]);

		// Overlap: the same page shows up under both categories independently.
		const code = (await h.invokeTool("web_fetch", { category: "Code" })) as ToolResult;
		expect(JSON.parse(code.content[0].text).pages.map((p: { url: string }) => p.url)).toEqual([`${server.baseUrl}/category-me`]);
		const ptp = (await h.invokeTool("web_fetch", { category: "PTP Protocol" })) as ToolResult;
		expect(JSON.parse(ptp.content[0].text).pages.map((p: { url: string }) => p.url)).toEqual([`${server.baseUrl}/category-me`]);

		const removed = (await h.invokeTool("web_category", {
			operation: "remove",
			url: `${server.baseUrl}/category-me`,
			category: "Code",
		})) as ToolResult;
		expect(JSON.parse(removed.content[0].text)).toMatchObject({ removed: true });
		const afterRemove = (await h.invokeTool("web_fetch", { category: "Code" })) as ToolResult;
		expect(JSON.parse(afterRemove.content[0].text).pages).toEqual([]);
	});

	it("rename merges into an existing category rather than erroring", async () => {
		server.set("/rename-me", "<html><body><article><h1>Rename me</h1><p>Testing rename/merge.</p></article></body></html>");
		await h.invokeTool("web_fetch", { url: `${server.baseUrl}/rename-me` });
		await h.invokeTool("web_category", { operation: "assign", url: `${server.baseUrl}/rename-me`, category: "Old Name Unique" });
		await h.invokeTool("web_category", { operation: "assign", url: `${server.baseUrl}/rename-me`, category: "Existing Name Unique" });

		const renamed = (await h.invokeTool("web_category", {
			operation: "rename",
			category: "Old Name Unique",
			newName: "Existing Name Unique",
		})) as ToolResult;
		expect(JSON.parse(renamed.content[0].text)).toMatchObject({ name: "Existing Name Unique", merged: true });
	});

	it("throws a clear error assigning a category to a URL that isn't cached", async () => {
		await expect(
			h.invokeTool("web_category", { operation: "assign", url: `${server.baseUrl}/never-fetched`, category: "Code" }),
		).rejects.toThrow(/web_category failed/);
	});

	it("real Vehicle cross-cutting policy (Activity Broker) fires for a real call -- the gap a bare client.invoke() would have missed", async () => {
		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			server.set(
				"/activity-check",
				"<html><body><article><h1>Activity check</h1><p>Proving the decorator fires.</p></article></body></html>",
			);
			await h.invokeTool("web_fetch", { url: `${server.baseUrl}/activity-check` });

			await h.invokeTool("web_category", { operation: "assign", url: `${server.baseUrl}/activity-check`, category: "Activity Test" });

			const assignEvents = events.filter((e) => e.refs.operation === "category.assign");
			expect(assignEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
		} finally {
			unregisterActivityBroker();
		}
	});
});

describe("web_quotes: standalone resource-finder, end to end", () => {
	it("returns ranked, verbatim quotes with a working citationUrl per quote", async () => {
		server.set(
			"/quotes-a",
			"<html><body><article><h1>Clock sync</h1><p>The Precision Time Protocol synchronizes clocks across a network to sub-microsecond accuracy.</p></article></body></html>",
		);
		server.set(
			"/quotes-b",
			"<html><body><article><h1>Unrelated</h1><p>This page is about gardening tomatoes in containers.</p></article></body></html>",
		);

		const result = (await h.invokeTool("web_quotes", {
			query: "Precision Time Protocol clock synchronization",
			urls: [`${server.baseUrl}/quotes-a`, `${server.baseUrl}/quotes-b`],
		})) as ToolResult;

		const payload = JSON.parse(result.content[0].text);
		expect(payload.query).toBe("Precision Time Protocol clock synchronization");
		expect(payload.resources).toHaveLength(2);

		const hit = payload.resources.find((r: { url: string }) => r.url === `${server.baseUrl}/quotes-a`);
		expect(hit.quotes.length).toBeGreaterThan(0);
		expect(hit.quotes[0].text).toContain("Precision Time Protocol");
		expect(hit.quotes[0].citationUrl).toContain(`${server.baseUrl}/quotes-a#:~:text=`);

		expect(result.details).toMatchObject({ kind: "web-quotes", query: "Precision Time Protocol clock synchronization" });
	});

	it("isolates a per-url fetch failure without failing the whole batch", async () => {
		server.set(
			"/quotes-good",
			"<html><body><article><h1>Good page</h1><p>This one fetches fine and matches the query text.</p></article></body></html>",
		);

		const result = (await h.invokeTool("web_quotes", {
			query: "fetches fine",
			urls: [`${server.baseUrl}/quotes-good`, `${server.baseUrl}/quotes-missing`],
		})) as ToolResult;

		const payload = JSON.parse(result.content[0].text);
		const good = payload.resources.find((r: { url: string }) => r.url === `${server.baseUrl}/quotes-good`);
		const bad = payload.resources.find((r: { url: string }) => r.url === `${server.baseUrl}/quotes-missing`);
		expect(good.quotes.length).toBeGreaterThan(0);
		expect(bad.error).toBeDefined();
		expect(result.details).toMatchObject({ errors: 1 });
	});

	it("throws a clear error for an empty query", async () => {
		server.set("/quotes-empty-query", "<html><body><article><h1>x</h1><p>y</p></article></body></html>");
		await expect(h.invokeTool("web_quotes", { query: "", urls: [`${server.baseUrl}/quotes-empty-query`] })).rejects.toThrow(
			/web_quotes failed/,
		);
	});

	it("throws a clear error for an empty urls list", async () => {
		await expect(h.invokeTool("web_quotes", { query: "anything", urls: [] })).rejects.toThrow(/web_quotes failed/);
	});

	it("real Vehicle cross-cutting policy (Activity Broker) fires for a real call", async () => {
		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			server.set(
				"/quotes-activity-check",
				"<html><body><article><h1>Activity check</h1><p>Proving the decorator fires for quotes too.</p></article></body></html>",
			);
			await h.invokeTool("web_quotes", { query: "decorator fires", urls: [`${server.baseUrl}/quotes-activity-check`] });

			const quotesEvents = events.filter((e) => e.refs.operation === "quotes");
			expect(quotesEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.completed"]);
		} finally {
			unregisterActivityBroker();
		}
	});

	it("renders a bounded summary card end to end instead of dumping raw JSON into the collapsed view", async () => {
		server.set(
			"/quotes-render-check",
			"<html><body><article><h1>Render check</h1><p>This exact sentence about clock synchronization must never appear collapsed.</p></article></body></html>",
		);
		const result = (await h.invokeTool("web_quotes", {
			query: "clock synchronization",
			urls: [`${server.baseUrl}/quotes-render-check`],
		})) as ToolResult;

		const definition = h.tools.get("web_quotes")?.definition;
		const theme = {
			fg: (_c: string, t: string) => t,
			bg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			italic: (t: string) => t,
			strikethrough: (t: string) => t,
			underline: (t: string) => t,
		} as unknown as Parameters<NonNullable<typeof definition.renderResult>>[2];
		const collapsed = definition
			?.renderResult?.(result, { expanded: false, isPartial: false }, theme, { cwd: "/tmp", isError: false } as never)
			?.render(80)
			.join("\n");
		expect(collapsed).not.toContain("This exact sentence about clock synchronization");
		expect(collapsed).toContain("quote");

		const expanded = definition
			?.renderResult?.(result, { expanded: true, isPartial: false }, theme, { cwd: "/tmp", isError: false } as never)
			?.render(80)
			.join("\n");
		expect(expanded).toContain("This exact sentence about clock synchronization");
	});
});
