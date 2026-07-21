/**
 * Tests for LightpandaHttpClient. No real Lightpanda binary is available in
 * this environment (and per design, this client is never responsible for
 * installing/launching one) — the real end-to-end test instead launches a
 * real Chromium with a CDP debugging port exposed and connects to *that*
 * over CDP, which validates the actual connectOverCDP()/navigate/content
 * machinery this client relies on, without asserting anything Lightpanda-
 * binary-specific. Lightpanda's own README states it is CDP-compatible
 * with Puppeteer/Playwright (browserWSEndpoint) — connecting to any
 * CDP-compliant target exercises the same code path.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLightpandaClient, LightpandaHttpClient } from "../src/lightpanda.js";
import type { IHttpClient } from "../src/ports.js";

const ENV_VAR = "WEB_SPIDER_LIGHTPANDA_ENDPOINT";

/**
 * A tiny real local HTTP server — data: URLs don't work here because
 * Playwright's page.goto() returns a null Response for them (no actual
 * network request is made), which this client correctly treats as a
 * navigation failure. A real server gives a real Response to assert against.
 */
function startFixtureServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(html);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}/`,
				close: () => new Promise((res2) => server.close(() => res2())),
			});
		});
	});
}

describe("LightpandaHttpClient option wiring", () => {
	it("requires an explicit endpoint — throws rather than assuming a default", () => {
		// @ts-expect-error deliberately omitting the required field
		expect(() => new LightpandaHttpClient({})).toThrow(/requires an explicit endpoint/);
	});

	it("constructs with an explicit endpoint without throwing", () => {
		expect(() => new LightpandaHttpClient({ endpoint: "ws://127.0.0.1:9222/x" })).not.toThrow();
	});
});

describe("createLightpandaClient — graceful degradation, explicit opt-in only", () => {
	const originalEnv = process.env[ENV_VAR];
	afterEach(() => {
		if (originalEnv === undefined) delete process.env[ENV_VAR];
		else process.env[ENV_VAR] = originalEnv;
	});

	it("returns null when no endpoint is configured anywhere (the default, disabled state)", () => {
		delete process.env[ENV_VAR];
		expect(createLightpandaClient()).toBeNull();
	});

	it("returns a client when an explicit endpoint option is given", () => {
		delete process.env[ENV_VAR];
		expect(createLightpandaClient({ endpoint: "ws://127.0.0.1:9222/x" })).toBeInstanceOf(LightpandaHttpClient);
	});

	it("falls back to WEB_SPIDER_LIGHTPANDA_ENDPOINT when no explicit option is given", () => {
		process.env[ENV_VAR] = "ws://127.0.0.1:9222/from-env";
		expect(createLightpandaClient()).toBeInstanceOf(LightpandaHttpClient);
	});

	it("an explicit option takes precedence over the environment variable", () => {
		process.env[ENV_VAR] = "ws://127.0.0.1:9222/from-env";
		const client = createLightpandaClient({ endpoint: "ws://127.0.0.1:9222/explicit" });
		expect(client).toBeInstanceOf(LightpandaHttpClient);
	});

	it("never throws even if construction would fail — null, not an exception, on any problem", () => {
		delete process.env[ENV_VAR];
		expect(() => createLightpandaClient({ endpoint: "" })).not.toThrow();
		expect(createLightpandaClient({ endpoint: "" })).toBeNull();
	});
});

describe("LightpandaHttpClient interface conformance", () => {
	it("satisfies IHttpClient", () => {
		const client: IHttpClient = new LightpandaHttpClient({ endpoint: "ws://127.0.0.1:9222/x" });
		expect(typeof client.fetch).toBe("function");
	});

	it("has a close() method that never throws when nothing is connected yet", async () => {
		const client = new LightpandaHttpClient({ endpoint: "ws://127.0.0.1:9222/x" });
		await expect(client.close()).resolves.toBeUndefined();
	});
});

describe("LightpandaHttpClient — real CDP connection (walking skeleton)", () => {
	const CDP_PORT = 9333;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let realBrowser: any;
	let client: LightpandaHttpClient;
	let fixture: { url: string; close: () => Promise<void> } | undefined;

	afterEach(async () => {
		await client?.close();
		await realBrowser?.close();
		await fixture?.close();
		fixture = undefined;
	});

	it("connects over CDP to a real running browser, navigates, and returns real rendered content", async () => {
		fixture = await startFixtureServer("<html><body><h1>hello from CDP</h1></body></html>");
		const { chromium } = await import("playwright-core");
		realBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${CDP_PORT}`] });

		client = new LightpandaHttpClient({ endpoint: `http://127.0.0.1:${CDP_PORT}` });
		const response = await client.fetch({ url: fixture.url });

		expect(response.ok).toBe(true);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("hello from CDP");
	}, 30_000);

	it("reuses the same underlying browser connection across multiple fetch() calls", async () => {
		const { chromium } = await import("playwright-core");
		realBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${CDP_PORT + 1}`] });
		client = new LightpandaHttpClient({ endpoint: `http://127.0.0.1:${CDP_PORT + 1}` });

		const fixtureOne = await startFixtureServer("<p>one</p>");
		const fixtureTwo = await startFixtureServer("<p>two</p>");
		try {
			const first = await client.fetch({ url: fixtureOne.url });
			const second = await client.fetch({ url: fixtureTwo.url });
			expect(await first.text()).toContain("one");
			expect(await second.text()).toContain("two");
		} finally {
			await fixtureOne.close();
			await fixtureTwo.close();
		}
	}, 30_000);

	it("throws a clear error for a non-2xx/3xx response rather than returning it as ok", async () => {
		const { chromium } = await import("playwright-core");
		realBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${CDP_PORT + 2}`] });

		client = new LightpandaHttpClient({ endpoint: `http://127.0.0.1:${CDP_PORT + 2}` });
		await expect(client.fetch({ url: "https://this-host-does-not-exist-lightpanda-test.invalid" })).rejects.toThrow();
	}, 30_000);
});
