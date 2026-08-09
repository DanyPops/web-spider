import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpideredPage } from "@danypops/web-spider";
import { SQLiteCacheStore } from "../src/cache/sqlite-cache-store.ts";
import { openWebSpiderDb } from "../src/db.ts";
import { createApp, createWebSpiderService, UnknownOperationError, type WebSpiderService } from "../src/service.ts";
import { VERSION } from "../src/version.ts";

const TOKEN = "test-token";
const services: WebSpiderService[] = [];
const tmpDirs: string[] = [];

function app() {
	const service = createWebSpiderService(":memory:");
	services.push(service);
	return { service, app: createApp({ service, token: TOKEN }) };
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal, real SpideredPage -- matches sqlite-cache-store.test.ts's own fixture shape. */
function page(url: string): SpideredPage {
	return {
		url,
		domain: new URL(url).hostname,
		fetchedAt: new Date().toISOString(),
		title: "Example",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 1,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: [],
		markdown: "# Example",
	};
}

/**
 * A real on-disk (not :memory:) db, seeded with one cached page before the
 * real WebSpiderService/createApp open their own connection to the same
 * file -- category.assign requires the page to already be cached, and
 * :memory: databases can't be shared across two separate connections.
 */
function appWithCachedPage(url: string): ReturnType<typeof app> {
	const dir = mkdtempSync(join(tmpdir(), "web-spider-vehicle-test-"));
	tmpDirs.push(dir);
	const dbPath = join(dir, "web-spider.db");
	const seedDb = openWebSpiderDb(dbPath);
	new SQLiteCacheStore(seedDb, { imagesDir: join(dir, "images") }).set(url, page(url));
	seedDb.close();
	const service = createWebSpiderService(dbPath);
	services.push(service);
	return { service, app: createApp({ service, token: TOKEN }) };
}

describe("createApp — authentication", () => {
	test("rejects a request with no bearer token", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/health"));
		expect(response.status).toBe(401);
	});

	test("rejects a request with the wrong bearer token", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/health", { headers: { authorization: "Bearer wrong" } }));
		expect(response.status).toBe(401);
	});

	test("accepts a request with the correct bearer token", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/health", { headers: { authorization: `Bearer ${TOKEN}` } }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; version: string };
		expect(body.ok).toBe(true);
		expect(typeof body.version).toBe("string");
	});
});

describe("createApp — operation discovery and dispatch", () => {
	test("GET /api/v1/ops lists the registered operations", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", { headers: { authorization: `Bearer ${TOKEN}` } }));
		const body = (await response.json()) as { operations: string[] };
		expect(body.operations).toContain("cache.list");
		expect(body.operations).toContain("cache.search");
	});

	test("POST /api/v1/ops executes a real operation end-to-end (cache.list on an empty store)", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "cache.list", input: {} }),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { total: number; pages: unknown[] } };
		expect(body.result.total).toBe(0);
		expect(body.result.pages).toEqual([]);
	});

	test("POST /api/v1/ops executes cache.search end-to-end (empty store, no hits)", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "cache.search", input: { query: "anything" } }),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { query: string; pagesSearched: number; hits: unknown[] } };
		expect(body.result).toEqual({ query: "anything", pagesSearched: 0, hits: [] });
	});

	test("POST /api/v1/ops rejects cache.search with a missing query as a 400", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "cache.search", input: {} }),
			}),
		);
		expect(response.status).toBe(400);
	});

	test("POST /api/v1/ops rejects an unknown operation with 404", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "does.not.exist", input: {} }),
			}),
		);
		expect(response.status).toBe(404);
	});

	test("POST /api/v1/ops rejects a missing op with 400", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ input: {} }),
			}),
		);
		expect(response.status).toBe(400);
	});

	test("unrouted paths return 404", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/nope", { headers: { authorization: `Bearer ${TOKEN}` } }));
		expect(response.status).toBe(404);
	});
});

describe("WebSpiderService.execute", () => {
	test("rejects with UnknownOperationError for an unregistered operation", async () => {
		const { service } = app();
		await expect(service.execute("nope")).rejects.toThrow(UnknownOperationError);
	});
});

describe("createApp — /vehicle/* (category.* Vehicle protocol migration)", () => {
	// Permissions are explicit opt-in per invoke (VehicleRegistry.invoke checks
	// options.permissions against the operation's own declared list, never implied
	// by bearer-token auth alone) -- matches the fixed allowlist every migrated
	// pi-extension client passes at its own registerVehicleTools() call site.
	async function invoke(server: ReturnType<typeof app>["app"], name: string, input: Record<string, unknown>) {
		return server.fetch(
			new Request("http://x/vehicle/invoke", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
			}),
		);
	}

	test("GET /vehicle/manifest requires the same bearer token as every other route", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/vehicle/manifest"));
		expect(response.status).toBe(401);
	});

	test("GET /vehicle/manifest reports the real package version, not a hardcoded placeholder", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/vehicle/manifest", { headers: { authorization: `Bearer ${TOKEN}` } }));
		const body = (await response.json()) as { version: string };
		expect(body.version).toBe(VERSION);
	});

	test("GET /vehicle/manifest lists every operation migrated onto the real Vehicle protocol", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/vehicle/manifest", { headers: { authorization: `Bearer ${TOKEN}` } }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { operations: Array<{ name: string }> };
		const names = body.operations.map((operation) => operation.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"category.assign",
				"category.remove",
				"category.rename",
				"category.list",
				"cache.list",
				"cache.search",
				"search",
				"search.usage",
				"fetch",
				"crawl",
				"session.create",
				"session.list",
				"session.close",
				"session.act",
			]),
		);
	});

	test("cache.list and cache.search round-trip through the real Vehicle wire protocol, matching the /api/v1/ops shape", async () => {
		const { app: server } = appWithCachedPage("https://example.test/a");

		const listed = await invoke(server, "cache.list", {});
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as { output: { total: number; pages: Array<{ url: string }> } };
		expect(listedBody.output.total).toBe(1);
		expect(listedBody.output.pages).toEqual([expect.objectContaining({ url: "https://example.test/a" })]);

		const searched = await invoke(server, "cache.search", { query: "Example" });
		expect(searched.status).toBe(200);
		const searchedBody = (await searched.json()) as { output: { query: string; hits: Array<{ url: string }> } };
		expect(searchedBody.output.query).toBe("Example");
		expect(searchedBody.output.hits).toEqual([expect.objectContaining({ url: "https://example.test/a" })]);
	});

	test("cache.search with a missing query fails with a real Vehicle validation error, not a crash", async () => {
		const { app: server } = app();
		const response = await invoke(server, "cache.search", {});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { category: string } };
		expect(body.error.category).toBe("validation");
	});

	test("category.list, category.assign, and category.remove round-trip through the real Vehicle wire protocol", async () => {
		const { app: server } = appWithCachedPage("https://example.test/a");

		const empty = await invoke(server, "category.list", {});
		expect(empty.status).toBe(200);
		expect(((await empty.json()) as { output: { categories: unknown[] } }).output.categories).toEqual([]);

		const assigned = await invoke(server, "category.assign", { url: "https://example.test/a", category: "Code" });
		expect(assigned.status).toBe(200);
		const assignedBody = (await assigned.json()) as { output: { url: string; category: string; categoryId: number } };
		expect(assignedBody.output.url).toBe("https://example.test/a");
		expect(assignedBody.output.category).toBe("Code");

		const listed = await invoke(server, "category.list", {});
		const listedBody = (await listed.json()) as { output: { categories: Array<{ id: number; name: string; pageCount: number }> } };
		expect(listedBody.output.categories).toEqual([{ id: expect.any(Number), name: "Code", pageCount: 1 }]);

		const removed = await invoke(server, "category.remove", { url: "https://example.test/a", category: "Code" });
		expect(removed.status).toBe(200);
		expect(((await removed.json()) as { output: { removed: true } }).output.removed).toBe(true);
	});

	test("category.assign with a missing required field fails with a real Vehicle validation error, not a crash", async () => {
		const { app: server } = app();
		const response = await invoke(server, "category.assign", { url: "https://example.test/a" });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { code: string; category: string } };
		expect(body.error.category).toBe("validation");
	});

	test("the old /api/v1/ops route for category.* keeps working unchanged, alongside /vehicle/invoke", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "category.list", input: {} }),
			}),
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { result: { categories: unknown[] } }).result.categories).toEqual([]);
	});
});

describe("createApp — search", () => {
	test("POST /api/v1/ops rejects search with a missing query as a 400", async () => {
		const { app: server } = app();
		const response = await server.fetch(
			new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ op: "search", input: {} }),
			}),
		);
		expect(response.status).toBe(400);
	});

	test("GET /api/v1/ops lists search alongside cache.list/cache.search", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", { headers: { authorization: `Bearer ${TOKEN}` } }));
		const body = (await response.json()) as { operations: string[] };
		expect(body.operations).toContain("search");
	});
});

describe("createApp — search.usage through the real Vehicle wire protocol", () => {
	async function invoke(server: ReturnType<typeof app>["app"], name: string, input: Record<string, unknown>) {
		return server.fetch(
			new Request("http://x/vehicle/invoke", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
			}),
		);
	}

	test("search.usage round-trips through the real Vehicle wire protocol (a pure local read, no network)", async () => {
		const { app: server } = app();
		const response = await invoke(server, "search.usage", {});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { output: { entries: unknown[] } };
		expect(body.output.entries).toEqual([]);
	});

	test("search with a missing query fails with a real Vehicle validation error, not a crash", async () => {
		const { app: server } = app();
		const response = await invoke(server, "search", {});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { category: string } };
		expect(body.error.category).toBe("validation");
	});
});
