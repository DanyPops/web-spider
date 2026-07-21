import { describe, expect, test } from "bun:test";
import { createApp, createWebSpiderService, UnknownOperationError } from "../src/service.ts";

const TOKEN = "test-token";

function app() {
	const service = createWebSpiderService(":memory:");
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
		const body = await response.json() as { ok: boolean; version: string };
		expect(body.ok).toBe(true);
		expect(typeof body.version).toBe("string");
	});
});

describe("createApp — operation discovery and dispatch", () => {
	test("GET /api/v1/ops lists the registered operations", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", { headers: { authorization: `Bearer ${TOKEN}` } }));
		const body = await response.json() as { operations: string[] };
		expect(body.operations).toContain("cache.list");
		expect(body.operations).toContain("cache.search");
	});

	test("POST /api/v1/ops executes a real operation end-to-end (cache.list on an empty store)", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "cache.list", input: {} }),
		}));
		expect(response.status).toBe(200);
		const body = await response.json() as { result: { total: number; pages: unknown[] } };
		expect(body.result.total).toBe(0);
		expect(body.result.pages).toEqual([]);
	});

	test("POST /api/v1/ops executes cache.search end-to-end (empty store, no hits)", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "cache.search", input: { query: "anything" } }),
		}));
		expect(response.status).toBe(200);
		const body = await response.json() as { result: { query: string; pagesSearched: number; hits: unknown[] } };
		expect(body.result).toEqual({ query: "anything", pagesSearched: 0, hits: [] });
	});

	test("POST /api/v1/ops rejects cache.search with a missing query as a 400", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "cache.search", input: {} }),
		}));
		expect(response.status).toBe(400);
	});

	test("POST /api/v1/ops rejects an unknown operation with 404", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op: "does.not.exist", input: {} }),
		}));
		expect(response.status).toBe(404);
	});

	test("POST /api/v1/ops rejects a missing op with 400", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ input: {} }),
		}));
		expect(response.status).toBe(400);
	});

	test("unrouted paths return 404", async () => {
		const { app: server } = app();
		const response = await server.fetch(new Request("http://x/nope", { headers: { authorization: `Bearer ${TOKEN}` } }));
		expect(response.status).toBe(404);
	});
});

describe("WebSpiderService.execute", () => {
	test("throws UnknownOperationError for an unregistered operation", () => {
		const { service } = app();
		expect(() => service.execute("nope")).toThrow(UnknownOperationError);
	});
});
