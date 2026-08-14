/**
 * Real end-to-end integration: HTTP → auth → createWebSpiderService()'s
 * production wiring (real PlaywrightSessionRegistry + real
 * SQLiteSessionAuditJournal + SessionService) → an actual launched
 * chromium-headless-shell process. Proves the wiring, not just each unit
 * in isolation — the same path a real client (CLI, a future tool) uses.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApp, createWebSpiderService } from "../src/service.ts";

const TOKEN = "test-token";

async function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown>) {
	const response = await app.fetch(
		new Request("http://x/api/v1/ops", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ op, input }),
		}),
	);
	return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } };
}

describe("session.* operations — real end-to-end through createWebSpiderService/createApp", () => {
	test("create → act(navigate) → browser-driven link navigation rejects stale actions end to end", async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(req.url === "/first" ? "<a id='b' href='/second'>go</a>" : "<p id='destination'>there</p>");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const created = await post(app, "session.create", { name: "e2e" });
			expect(created.status).toBe(200);
			expect(created.body.result).toMatchObject({ name: "e2e", snapshotVersion: 0 });

			const navigate = await post(app, "session.act", {
				name: "e2e",
				snapshotVersion: 0,
				action: "navigate",
				url: `http://127.0.0.1:${port}/first`,
			});
			expect(navigate.status).toBe(200);
			expect((navigate.body.result as { snapshotVersion: number }).snapshotVersion).toBe(1);

			const stale = await post(app, "session.act", { name: "e2e", snapshotVersion: 0, action: "click", selector: "#b" });
			expect(stale.status).toBe(409);
			expect(stale.body.error).toMatch(/snapshot version mismatch/);

			const click = await post(app, "session.act", { name: "e2e", snapshotVersion: 1, action: "click", selector: "#b" });
			expect(click.status).toBe(200);
			expect((click.body.result as { snapshotVersion: number }).snapshotVersion).toBe(2);

			const staleAfterLinkNavigation = await post(app, "session.act", {
				name: "e2e",
				snapshotVersion: 1,
				action: "eval",
				script: "document.body.textContent",
			});
			expect(staleAfterLinkNavigation.status).toBe(409);

			const evalResult = await post(app, "session.act", {
				name: "e2e",
				snapshotVersion: 2,
				action: "eval",
				script: "document.getElementById('destination').textContent",
			});
			expect(evalResult.status).toBe(200);
			expect((evalResult.body.result as { result: unknown }).result).toBe("there");

			const screenshot = await post(app, "session.act", { name: "e2e", snapshotVersion: 2, action: "screenshot" });
			expect(screenshot.status).toBe(200);
			expect(typeof (screenshot.body.result as { screenshotBase64: string }).screenshotBase64).toBe("string");

			const closed = await post(app, "session.close", { name: "e2e" });
			expect(closed.body.result).toEqual({
				name: "e2e",
				closed: true,
				finalization: { context: "ok", browser: "ok", completed: true },
			});
		} finally {
			await service.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);

	test("acting on a nonexistent session returns a 404-shaped client error, not a 500", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const result = await post(app, "session.act", { name: "ghost", snapshotVersion: 0, action: "screenshot" });
			expect(result.status).toBe(404);
			expect(result.body.error).toMatch(/no such session/);
		} finally {
			await service.close();
		}
	});

	test("session.create rejects an unauthenticated request with 401, never launching a browser", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const response = await app.fetch(
				new Request("http://x/api/v1/ops", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: "session.create", input: { name: "e2e" } }),
				}),
			);
			expect(response.status).toBe(401);
			const list = await post(app, "session.list", {});
			expect((list.body.result as { sessions: unknown[] }).sessions).toHaveLength(0);
		} finally {
			await service.close();
		}
	});
});

describe("session.* operations — the same real end-to-end lifecycle, through the real Vehicle wire protocol", () => {
	async function invoke(app: { fetch(request: Request): Promise<Response> }, name: string, input: Record<string, unknown>) {
		const response = await app.fetch(
			new Request("http://x/vehicle/invoke", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ name, version: 1, input, permissions: ["web-spider:read", "web-spider:write"] }),
			}),
		);
		return { status: response.status, body: (await response.json()) as { output?: Record<string, unknown>; error?: { category: string } } };
	}

	test("create → act(navigate) → act(click, stale then fresh) → list → close, with the same 409/404 status parity /api/v1/ops already has", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const created = await invoke(app, "session.create", { name: "vehicle-e2e" });
			expect(created.status).toBe(200);
			expect(created.body.output).toMatchObject({ name: "vehicle-e2e", snapshotVersion: 0 });

			const navigate = await invoke(app, "session.act", {
				name: "vehicle-e2e",
				snapshotVersion: 0,
				action: "navigate",
				url: "data:text/html,<button id='b'>hi</button>",
			});
			expect(navigate.status).toBe(200);
			expect(navigate.body.output?.snapshotVersion).toBe(1);

			// Stale snapshot -> Vehicle's "conflict" category -> HTTP 409, same as /api/v1/ops's own StaleSnapshotError mapping.
			const stale = await invoke(app, "session.act", { name: "vehicle-e2e", snapshotVersion: 0, action: "click", selector: "#b" });
			expect(stale.status).toBe(409);
			expect(stale.body.error?.category).toBe("conflict");

			const click = await invoke(app, "session.act", { name: "vehicle-e2e", snapshotVersion: 1, action: "click", selector: "#b" });
			expect(click.status).toBe(200);

			const list = await invoke(app, "session.list", {});
			expect(((list.body.output?.sessions ?? []) as unknown[]).length).toBe(1);

			const closed = await invoke(app, "session.close", { name: "vehicle-e2e" });
			expect(closed.body.output).toEqual({
				name: "vehicle-e2e",
				closed: true,
				finalization: { context: "ok", browser: "ok", completed: true },
			});

			const listAfterClose = await invoke(app, "session.list", {});
			expect(((listAfterClose.body.output?.sessions ?? []) as unknown[]).length).toBe(0);
		} finally {
			await service.close();
		}
	}, 30_000);

	test("acting on a nonexistent session maps to Vehicle's \"not_found\" category -> HTTP 404, same as /api/v1/ops's own SessionNotFoundError mapping", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const result = await invoke(app, "session.act", { name: "ghost", snapshotVersion: 0, action: "screenshot" });
			expect(result.status).toBe(404);
			expect(result.body.error?.category).toBe("not_found");
		} finally {
			await service.close();
		}
	});
});
