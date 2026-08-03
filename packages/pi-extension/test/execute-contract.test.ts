import { registerActivityBroker, unregisterActivityBroker } from "@danypops/vehicle-client-pi/activity-broker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import piFactory from "../src/index.js";
import { type IsolatedDaemonEnv, isolatedDaemonEnv } from "./daemon-isolation.js";
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

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
	});

	it("throws invalid URL failures through Pi's native error channel", async () => {
		await expect(h.invokeTool("web_fetch", { url: "ftp://not-supported.example.com" })).rejects.toThrow("Unsupported protocol");
	});

	it("throws unreachable-host failures through Pi's native error channel", async () => {
		await expect(
			h.invokeTool("web_fetch", {
				url: "http://this-host-does-not-exist-pivi-test.invalid",
				timeoutMs: 3000,
			}),
		).rejects.toThrow("web_fetch failed");
	});

	it("missing url returns a typed cache listing", async () => {
		const result = (await h.invokeTool("web_fetch", {})) as any;
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

		const result = (await h.invokeTool("web_fetch", { url: `${server.baseUrl}/private` })) as any;
		expect(JSON.parse(result.content[0].text)).toMatchObject({ blocked: true, reason: "robots.txt" });
		expect(result.details).toMatchObject({ kind: "web", status: "blocked", blockedBy: "robots.txt" });
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

		const result = (await h.invokeTool("web_fetch", { tag: "ptp" })) as any;
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

describe("ingest: explicit opt-in Papyrus wiring", () => {
	it("never calls papyrus.ingest when ingest is omitted (default behavior unchanged)", async () => {
		server.set("/plain", "<html><body><article><h1>Plain</h1><p>No mesh.</p></article></body></html>");
		const result = (await h.invokeTool("web_fetch", { url: `${server.baseUrl}/plain`, format: "lean" })) as any;
		expect(JSON.parse(result.content[0].text)).not.toHaveProperty("papyrus");
		expect(result.details.papyrusDocs).toBeUndefined();
	});

	it("forwards ingest:true for a single-page fetch to the daemon's papyrus.ingest op, which fails closed with no Papyrus daemon reachable in this isolated test environment", async () => {
		server.set("/ingest-me", "<html><body><article><h1>Ingest me</h1><p>Worth keeping.</p></article></body></html>");
		await expect(h.invokeTool("web_fetch", { url: `${server.baseUrl}/ingest-me`, format: "lean", ingest: true })).rejects.toThrow(
			/Papyrus daemon is not running|Papyrus daemon state is stale/,
		);
	});

	it("papyrus.ingest now routes through the real Vehicle protocol -- Activity Broker fires even on its own fail-closed rejection", async () => {
		const events: Array<{ type: string; refs: Record<string, unknown> }> = [];
		registerActivityBroker({ publish: (event) => events.push(event) });
		try {
			server.set("/ingest-broker-check", "<html><body><article><h1>Broker check</h1><p>Worth keeping.</p></article></body></html>");
			await expect(
				h.invokeTool("web_fetch", { url: `${server.baseUrl}/ingest-broker-check`, format: "lean", ingest: true }),
			).rejects.toThrow();

			const ingestEvents = events.filter((e) => e.refs.operation === "papyrus.ingest");
			expect(ingestEvents.map((e) => e.type)).toEqual(["vehicle.operation.started", "vehicle.operation.failed"]);
		} finally {
			unregisterActivityBroker();
		}
	});

	// The search-path wiring (maybeIngestSearch) uses the exact same call() helper and
	// papyrus.ingest operation as the fetch path exercised above; a live-network search-
	// engine round trip isn't repeated here to avoid a flaky, network-dependent test.
	// Search-specific mapping/bounding is covered by web-spider-daemon's
	// papyrus-mapping.test.ts and papyrus-ingest-service.test.ts.
});

describe("web_category: curated relevance categories, end to end", () => {
	it("assign/list/remove round-trip through the real daemon, with real overlap across two categories", async () => {
		server.set("/category-me", "<html><body><article><h1>Category me</h1><p>Something worth curating.</p></article></body></html>");
		await h.invokeTool("web_fetch", { url: `${server.baseUrl}/category-me` });

		const assignCode = (await h.invokeTool("web_category", {
			operation: "assign",
			url: `${server.baseUrl}/category-me`,
			category: "Code",
		})) as any;
		expect(JSON.parse(assignCode.content[0].text)).toMatchObject({ category: "Code" });

		const assignPtp = (await h.invokeTool("web_category", {
			operation: "assign",
			url: `${server.baseUrl}/category-me`,
			category: "PTP Protocol",
		})) as any;
		expect(JSON.parse(assignPtp.content[0].text)).toMatchObject({ category: "PTP Protocol" });

		const list = (await h.invokeTool("web_category", { operation: "list" })) as any;
		const categories = JSON.parse(list.content[0].text).categories;
		expect(categories.map((c: { name: string }) => c.name).sort()).toEqual(["Code", "PTP Protocol"]);

		// Overlap: the same page shows up under both categories independently.
		const code = (await h.invokeTool("web_fetch", { category: "Code" })) as any;
		expect(JSON.parse(code.content[0].text).pages.map((p: { url: string }) => p.url)).toEqual([`${server.baseUrl}/category-me`]);
		const ptp = (await h.invokeTool("web_fetch", { category: "PTP Protocol" })) as any;
		expect(JSON.parse(ptp.content[0].text).pages.map((p: { url: string }) => p.url)).toEqual([`${server.baseUrl}/category-me`]);

		const removed = (await h.invokeTool("web_category", {
			operation: "remove",
			url: `${server.baseUrl}/category-me`,
			category: "Code",
		})) as any;
		expect(JSON.parse(removed.content[0].text)).toMatchObject({ removed: true });
		const afterRemove = (await h.invokeTool("web_fetch", { category: "Code" })) as any;
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
		})) as any;
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
