/**
 * Playwright adapter — implements IHttpClient using a headless browser.
 *
 * Uses playwright-extra with the stealth plugin, which patches ~15 headless
 * fingerprint signals (navigator.webdriver, User-Agent, plugins, WebGL, etc.)
 * so the browser is indistinguishable from a real Chrome session.
 *
 * Requires system-installed Chrome (channel:"chrome") — no browser binary
 * is downloaded. Falls back gracefully to plain playwright-core if
 * playwright-extra or the stealth plugin are not installed.
 *
 * Browser lifecycle:
 *   - Launched lazily on the first fetch() call.
 *   - Reused across all subsequent requests (one browser, one tab per request).
 *   - Call close() when done to release the browser process.
 *
 * Usage:
 *   const client = new PlaywrightHttpClient()
 *   const page   = await spider(url, { httpClient: client })
 *   await client.close()
 */

import type { HttpRequest, HttpResponse, IHttpClient } from "./ports.js";

export interface PlaywrightClientOptions {
	/**
	 * Browser channel — finds a system-installed browser automatically.
	 * "chrome"   — Google Chrome (default)
	 * "msedge"   — Microsoft Edge
	 * "chromium" — Playwright's own Chromium (must be installed separately)
	 */
	channel?: "chrome" | "msedge" | "chromium";
	/**
	 * Explicit path to a browser executable.
	 * Overrides `channel`. Use when Chrome is not in the standard location.
	 */
	executablePath?: string;
	/**
	 * Navigation timeout in ms. Default: 30 000.
	 */
	timeoutMs?: number;
	/**
	 * When to consider navigation complete.
	 * "networkidle"      — no network activity for 500ms (best for SPAs, default).
	 * "domcontentloaded" — HTML parsed; faster but may miss lazy-loaded content.
	 * "load"             — window load event fired.
	 */
	waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
	/**
	 * When true, image and media resource types are allowed through instead of
	 * being aborted. Required when spider() is called with captureImages: true
	 * so that individual image fetches via this client succeed.
	 * Fonts are always blocked regardless of this flag.
	 * Default: false.
	 */
	captureImages?: boolean;
}

// Module-level flag: stealth is wired to the playwright-extra chromium
// singleton once and stays active for the lifetime of the process.
let stealthApplied = false;

export class PlaywrightHttpClient implements IHttpClient {
	private browser: any | null = null;
	private readonly channel: string;
	private readonly executablePath: string;
	private readonly timeoutMs: number;
	private readonly waitUntil: string;
	private readonly captureImages: boolean;

	constructor(opts: PlaywrightClientOptions = {}) {
		this.channel = opts.channel ?? "chrome";
		this.executablePath = opts.executablePath ?? "";
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.waitUntil = opts.waitUntil ?? "networkidle";
		this.captureImages = opts.captureImages ?? false;
	}

	private async getChromium() {
		// Prefer playwright-extra + stealth — patches headless fingerprints.
		// Falls back to plain playwright-core if playwright-extra isn't installed.
		try {
			const { chromium } = await import("playwright-extra");
			if (!stealthApplied) {
				const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
				chromium.use(StealthPlugin());
				stealthApplied = true;
			}
			return chromium;
		} catch {
			const { chromium } = await import("playwright-core");
			return chromium;
		}
	}

	private async getBrowser() {
		if (this.browser?.isConnected()) return this.browser;
		const chromium = await this.getChromium();
		const launchOpts = this.executablePath
			? { executablePath: this.executablePath, headless: true }
			: { channel: this.channel, headless: true };
		this.browser = await chromium.launch(launchOpts);
		return this.browser;
	}

	async fetch(req: HttpRequest): Promise<HttpResponse> {
		const browser = await this.getBrowser();
		const page: any = await browser.newPage();

		// Suppress browser-side console output and JS errors — they are not
		// useful to the caller and would leak into Pi's TUI stream.
		page.on("console", () => {});
		page.on("pageerror", () => {});

		try {
			// Block fonts always (never needed for HTML extraction).
			// Block images and media during page navigation for speed — unless
			// this is a direct image fetch (Accept: image/*), in which case
			// captureImages:true lets it through so fetchImages() can retrieve
			// the binary via arrayBuffer().
			await page.route("**/*", (route: any) => {
				const type: string = route.request().resourceType();
				const accept: string = route.request().headers().accept ?? "";
				const isImageFetch = accept.startsWith("image/");

				if (type === "font") {
					route.abort();
				} else if (["image", "media"].includes(type) && !(this.captureImages && isImageFetch)) {
					route.abort();
				} else {
					route.continue();
				}
			});

			const response = await page.goto(req.url, {
				timeout: this.timeoutMs,
				waitUntil: this.waitUntil,
			});

			if (!response) {
				throw new Error(`Navigation failed — no response for ${req.url}`);
			}

			// A non-2xx status is a normal response, not an error — matches the
			// default fetch()-based IHttpClient's contract exactly (ok reflects the
			// status, nothing throws). Callers like the .md/llms.txt/robots.txt
			// discovery strategies rely on this to gracefully fall back on a 404
			// instead of crashing when this adapter is swapped in for the default.
			const status: number = response.status();

			// page.content() returns the full serialised DOM after JS execution.
			const html: string = await page.content();
			const headers: Record<string, string> = await response.allHeaders();

			return {
				ok: status >= 200 && status < 300,
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

	/** Close the shared browser process. Call when the client is no longer needed. */
	async close(): Promise<void> {
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
		}
	}
}

/**
 * Create a PlaywrightHttpClient, returning null if playwright-core is not
 * installed. Useful for graceful degradation in environments without a browser.
 */
export function createPlaywrightClient(opts?: PlaywrightClientOptions): PlaywrightHttpClient | null {
	try {
		return new PlaywrightHttpClient(opts);
	} catch {
		return null;
	}
}
