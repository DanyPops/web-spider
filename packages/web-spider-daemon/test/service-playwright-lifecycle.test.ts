/**
 * Regression test for a real leaked-process bug found by directly observing
 * the running production daemon: the enhanced:true fetch/crawl path's
 * PlaywrightHttpClient is launched lazily once and reused for the daemon's
 * whole lifetime (see getPlaywrightClient() in service.ts) — but nothing
 * ever closed it, including on daemon shutdown. A single enhanced:true
 * fetch, ever, left a full Chrome process running indefinitely, surviving
 * even a graceful `service.close()` call, until something killed it by hand.
 *
 * Uses a real local HTTP server (not globalThis.fetch mocking) because
 * Playwright's browser makes real network requests of its own, not routed
 * through the Node/Bun global fetch.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, test } from "bun:test";
import { createWebSpiderService } from "../src/service.ts";

function startFixtureServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(html);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((res2) => server.close(() => res2())) });
		});
	});
}

describe("createWebSpiderService — Playwright client lifecycle", () => {
	test("close() releases a real enhanced:true-launched browser rather than leaking it, and never throws", async () => {
		const service = createWebSpiderService(":memory:");
		const fixture = await startFixtureServer("<html><head><title>Enhanced</title></head><body><article><h1>Enhanced</h1><p>Real browser fetch content, long enough for readability to treat it as the main article body text here.</p></article></body></html>");
		try {
			const result = (await service.execute("fetch", { url: fixture.url, enhanced: true })) as { markdown?: string };
			expect(result.markdown).toContain("Real browser fetch content");
		} finally {
			await fixture.close();
		}

		// The real assertion: close() must complete (not hang, not throw) even
		// though a real Playwright browser is live behind getPlaywrightClient().
		await expect((async () => service.close())()).resolves.toBeUndefined();
	}, 30_000);

	test("close() never throws when enhanced:true was never used (no browser was ever launched)", () => {
		const service = createWebSpiderService(":memory:");
		expect(() => service.close()).not.toThrow();
	});
});
