/**
 * search.testKeys -- live-validates every locally stored key for one
 * provider (`web-spider search-key test <engine>`'s daemon-side operation).
 * Network egress belongs to the daemon (architecture-wide convention), so
 * this is a real Vehicle operation, not a CLI-local filesystem-only one
 * like search-key add/list/remove.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, createWebSpiderService, type WebSpiderService } from "../src/service.ts";

const TOKEN = "test-token";
const services: WebSpiderService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
});

function appWithKeys(loadSearchKeys: (engine: string) => string[]) {
	const service = createWebSpiderService(":memory:", { loadSearchKeys });
	services.push(service);
	return createApp({ service, token: TOKEN });
}

async function invoke(server: ReturnType<typeof appWithKeys>, name: string, input: Record<string, unknown>) {
	return server.fetch(
		new Request("http://x/vehicle/invoke", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
		}),
	);
}

describe("search.testKeys", () => {
	test("reports each stored key's status by index, never the raw key, through the real Vehicle wire protocol", async () => {
		const server = appWithKeys((engine) => (engine === "tavily" ? ["good-key", "bad-key"] : []));

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
			if (auth === "Bearer bad-key") return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		}) as typeof fetch;

		try {
			const response = await invoke(server, "search.testKeys", { engine: "tavily" });
			expect(response.status).toBe(200);
			const body = (await response.json()) as { output: { engine: string; results: Array<{ index: number; status: string }> } };
			expect(body.output.engine).toBe("tavily");
			expect(body.output.results).toEqual([
				{ index: 0, status: "valid" },
				{ index: 1, status: "invalid" },
			]);
			const raw = JSON.stringify(body);
			expect(raw).not.toContain("good-key");
			expect(raw).not.toContain("bad-key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("reports an empty results array for a provider with nothing stored, rather than failing", async () => {
		const server = appWithKeys(() => []);
		const response = await invoke(server, "search.testKeys", { engine: "brave" });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { output: { engine: string; results: unknown[] } };
		expect(body.output).toEqual({ engine: "brave", results: [] });
	});

	test("fails with a real Vehicle validation error for a missing engine, not a crash", async () => {
		const server = appWithKeys(() => []);
		const response = await invoke(server, "search.testKeys", {});
		expect(response.status).toBe(400);
	});
});
