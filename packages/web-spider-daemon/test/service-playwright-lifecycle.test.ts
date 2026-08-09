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

import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Logger } from "@danypops/vehicle-server/logging";
import type { HttpResponse, IHttpClient } from "@danypops/web-spider";
import { createWebSpiderService } from "../src/service.ts";

function fakeLogger(): Logger & { warnCalls: Array<{ msg: string; fields?: Record<string, unknown> }> } {
	const warnCalls: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
	return {
		warnCalls,
		debug: () => {},
		info: () => {},
		warn: (msg, fields) => {
			warnCalls.push({ msg, fields });
		},
		error: () => {},
	};
}

function htmlResponse(): HttpResponse {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: () => "text/html" },
		text: async () =>
			"<html><head><title>Fake</title></head><body><article><h1>Fake</h1><p>Enough deterministic content for the fake enhanced client response.</p></article></body></html>",
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakeEnhancedClient implements IHttpClient {
	fetchCalls = 0;
	closeCalls = 0;

	constructor(private readonly closeImpl: () => Promise<void> = () => Promise.resolve()) {}

	async fetch(): Promise<HttpResponse> {
		this.fetchCalls++;
		return htmlResponse();
	}

	close(): Promise<void> {
		this.closeCalls++;
		return this.closeImpl();
	}
}

async function useEnhancedClient(service: ReturnType<typeof createWebSpiderService>): Promise<void> {
	await service.execute("fetch", { url: "https://example.test/enhanced", enhanced: true, ignoreRobots: true });
}

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
		const fixture = await startFixtureServer(
			"<html><head><title>Enhanced</title></head><body><article><h1>Enhanced</h1><p>Real browser fetch content, long enough for readability to treat it as the main article body text here.</p></article></body></html>",
		);
		try {
			const result = (await service.execute("fetch", { url: fixture.url, enhanced: true })) as { markdown?: string };
			expect(result.markdown).toContain("Real browser fetch content");
		} finally {
			await fixture.close();
		}

		// The real assertion: close() must complete (not hang, not throw) even
		// though a real Playwright browser is live behind getPlaywrightClient().
		await expect(service.close()).resolves.toBeUndefined();
	}, 30_000);

	test("close() waits for an injected enhanced client to finish closing", async () => {
		const gate = deferred();
		const client = new FakeEnhancedClient(() => gate.promise);
		const service = createWebSpiderService(":memory:", { logger: fakeLogger(), enhancedClientFactory: () => client });
		await useEnhancedClient(service);

		const shutdown = service.close();
		let settled = false;
		void shutdown.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(client.fetchCalls).toBe(1);
		expect(client.closeCalls).toBe(1);
		expect(settled).toBe(false);
		gate.resolve();
		await expect(shutdown).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	test("close() is idempotent and closes an enhanced client exactly once", async () => {
		const gate = deferred();
		const client = new FakeEnhancedClient(() => gate.promise);
		const service = createWebSpiderService(":memory:", { logger: fakeLogger(), enhancedClientFactory: () => client });
		await useEnhancedClient(service);

		const first = service.close();
		const second = service.close();
		expect(second).toBe(first);
		expect(client.closeCalls).toBe(1);
		gate.resolve();
		await Promise.all([first, second]);
	});

	test("close() before enhanced use never constructs the lazy client", async () => {
		let factoryCalls = 0;
		const service = createWebSpiderService(":memory:", {
			enhancedClientFactory: () => {
				factoryCalls++;
				return new FakeEnhancedClient();
			},
		});

		await expect(service.close()).resolves.toBeUndefined();
		expect(factoryCalls).toBe(0);
	});

	test("an enhanced-client close rejection is awaited and logged without rejecting shutdown", async () => {
		const logger = fakeLogger();
		const client = new FakeEnhancedClient(() => Promise.reject(new Error("simulated browser.close() failure")));
		const service = createWebSpiderService(":memory:", { logger, enhancedClientFactory: () => client });
		await useEnhancedClient(service);

		await expect(service.close()).resolves.toBeUndefined();
		expect(client.closeCalls).toBe(1);
		expect(logger.warnCalls).toContainEqual({
			msg: "playwright_close_failed",
			fields: { error: "Error: simulated browser.close() failure" },
		});
	});
});
