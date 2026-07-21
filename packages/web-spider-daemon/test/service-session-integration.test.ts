/**
 * Real end-to-end integration: HTTP → auth → createWebSpiderService()'s
 * production wiring (real PlaywrightSessionRegistry + real
 * SQLiteSessionAuditJournal + SessionService) → an actual launched
 * chromium-headless-shell process. Proves the wiring, not just each unit
 * in isolation — the same path a real client (CLI, a future tool) uses.
 */
import { describe, expect, test } from "bun:test";
import { createApp, createWebSpiderService } from "../src/service.ts";

const TOKEN = "test-token";

async function post(app: { fetch(request: Request): Promise<Response> }, op: string, input: Record<string, unknown>) {
	const response = await app.fetch(new Request("http://x/api/v1/ops", {
		method: "POST",
		headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ op, input }),
	}));
	return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } };
}

describe("session.* operations — real end-to-end through createWebSpiderService/createApp", () => {
	test("create → act(navigate) → act(click) → act(eval) → act(screenshot) → list → close, with a stale-snapshot rejection along the way", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const created = await post(app, "session.create", { name: "e2e" });
			expect(created.status).toBe(200);
			const info = created.body.result as { name: string; snapshotVersion: number };
			expect(info).toMatchObject({ name: "e2e", snapshotVersion: 0 });

			const navigate = await post(app, "session.act", {
				name: "e2e", snapshotVersion: 0, action: "navigate", url: "data:text/html,<button id='b'>hi</button>",
			});
			expect(navigate.status).toBe(200);
			expect((navigate.body.result as { snapshotVersion: number }).snapshotVersion).toBe(1);

			// Stale: still trying with the pre-navigate version.
			const stale = await post(app, "session.act", { name: "e2e", snapshotVersion: 0, action: "click", selector: "#b" });
			expect(stale.status).toBe(409);
			expect(stale.body.error).toMatch(/snapshot version mismatch/);

			const click = await post(app, "session.act", { name: "e2e", snapshotVersion: 1, action: "click", selector: "#b" });
			expect(click.status).toBe(200);
			expect((click.body.result as { snapshotVersion: number }).snapshotVersion).toBe(1); // click never bumps it

			const evalResult = await post(app, "session.act", {
				name: "e2e", snapshotVersion: 1, action: "eval", script: "document.getElementById('b').textContent",
			});
			expect(evalResult.status).toBe(200);
			expect((evalResult.body.result as { result: unknown }).result).toBe("hi");

			const screenshot = await post(app, "session.act", { name: "e2e", snapshotVersion: 1, action: "screenshot" });
			expect(screenshot.status).toBe(200);
			expect(typeof (screenshot.body.result as { screenshotBase64: string }).screenshotBase64).toBe("string");

			const list = await post(app, "session.list", {});
			expect((list.body.result as { sessions: unknown[] }).sessions).toHaveLength(1);

			const closed = await post(app, "session.close", { name: "e2e" });
			expect(closed.body.result).toEqual({ name: "e2e", closed: true });

			const listAfterClose = await post(app, "session.list", {});
			expect((listAfterClose.body.result as { sessions: unknown[] }).sessions).toHaveLength(0);
		} finally {
			service.close();
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
			service.close();
		}
	});

	test("session.create rejects an unauthenticated request with 401, never launching a browser", async () => {
		const service = createWebSpiderService(":memory:");
		const app = createApp({ service, token: TOKEN });
		try {
			const response = await app.fetch(new Request("http://x/api/v1/ops", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "session.create", input: { name: "e2e" } }),
			}));
			expect(response.status).toBe(401);
			const list = await post(app, "session.list", {});
			expect((list.body.result as { sessions: unknown[] }).sessions).toHaveLength(0);
		} finally {
			service.close();
		}
	});
});
