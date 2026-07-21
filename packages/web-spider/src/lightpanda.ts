/**
 * Lightpanda adapter — implements IHttpClient by connecting to an
 * operator-supplied Lightpanda instance over the Chrome DevTools Protocol
 * (CDP), via playwright-core's own connectOverCDP() rather than a hand-rolled
 * CDP client (playwright-core is already an optional dependency of this
 * package, and CDP is a public, standardized protocol — reusing its
 * connection handling avoids writing our own WebSocket/JSON-RPC framing).
 *
 * Deliberately narrow, per
 * decision-proceed-with-lightpandahttpclient-as-a-mere-aggrega-x407:
 *   - never installs, bundles, downloads, or auto-launches the Lightpanda
 *     binary or a Docker image — the operator runs their own instance and
 *     supplies its endpoint;
 *   - off by default; createLightpandaClient() returns null (graceful
 *     degradation, mirroring createPlaywrightClient()) unless an endpoint is
 *     explicitly configured;
 *   - for the general-purpose fetch/crawl path only (post-JS-executed
 *     DOM/text extraction) — NOT for the UI-audit session work, which needs
 *     real CSS layout/paint/WebGL that Lightpanda's README states it does
 *     not implement (see doc
 *     research-lightweight-browser-engine-options-for-the-session--0z7r).
 *
 * Usage:
 *   const client = createLightpandaClient({ endpoint: "ws://127.0.0.1:9222" })
 *   if (client) { const page = await spider(url, { httpClient: client }); await client.close() }
 */
import type { HttpRequest, HttpResponse, IHttpClient } from "./ports.js";

export interface LightpandaClientOptions {
	/**
	 * CDP endpoint of an already-running Lightpanda instance the operator
	 * controls — a ws:// URL or an http:// URL Playwright can resolve to one
	 * (see playwright-core's connectOverCDP). Required; there is no default
	 * endpoint and nothing is auto-discovered or auto-started.
	 */
	endpoint: string;
	/** Navigation timeout in ms. Default: 30 000. */
	timeoutMs?: number;
}

export class LightpandaHttpClient implements IHttpClient {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private browser: any | null = null;
	private readonly endpoint: string;
	private readonly timeoutMs: number;

	constructor(opts: LightpandaClientOptions) {
		if (!opts.endpoint) throw new Error("LightpandaHttpClient requires an explicit endpoint — none is assumed or auto-discovered");
		this.endpoint = opts.endpoint;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	private async getBrowser() {
		if (this.browser?.isConnected()) return this.browser;
		const { chromium } = await import("playwright-core");
		this.browser = await chromium.connectOverCDP(this.endpoint);
		return this.browser;
	}

	async fetch(req: HttpRequest): Promise<HttpResponse> {
		const browser = await this.getBrowser();
		const context = browser.contexts()[0] ?? (await browser.newContext());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const page: any = await context.newPage();

		page.on("console", () => {});
		page.on("pageerror", () => {});

		try {
			const response = await page.goto(req.url, {
				timeout: this.timeoutMs,
				waitUntil: "networkidle",
			});

			if (!response) {
				throw new Error(`Navigation failed — no response for ${req.url}`);
			}

			const status: number = response.status();
			if (status >= 400) {
				throw new Error(`HTTP ${status} ${response.statusText()} — ${req.url}`);
			}

			const html: string = await page.content();
			const headers: Record<string, string> = await response.allHeaders();

			return {
				ok: true,
				status,
				statusText: response.statusText(),
				headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
				text: async () => html,
				arrayBuffer: async () => {
					const buf: Buffer = await response.body();
					return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
				},
			};
		} finally {
			await page.close();
		}
	}

	/**
	 * Closes this client's Playwright-side connection only — never the
	 * remote Lightpanda process itself, which this client never started and
	 * does not own the lifecycle of.
	 */
	async close(): Promise<void> {
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
		}
	}
}

/**
 * Creates a LightpandaHttpClient, or returns null if no endpoint is
 * configured — explicit opt-in only, never a silent default. Reads
 * WEB_SPIDER_LIGHTPANDA_ENDPOINT when opts.endpoint is omitted; set neither
 * to disable Lightpanda entirely (the default, unconfigured state).
 */
export function createLightpandaClient(
	opts: Partial<LightpandaClientOptions> = {},
): LightpandaHttpClient | null {
	const endpoint = opts.endpoint ?? process.env["WEB_SPIDER_LIGHTPANDA_ENDPOINT"];
	if (!endpoint) return null;
	try {
		return new LightpandaHttpClient({ endpoint, timeoutMs: opts.timeoutMs });
	} catch {
		return null;
	}
}
