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
}
export declare class PlaywrightHttpClient implements IHttpClient {
    private browser;
    private readonly channel;
    private readonly executablePath;
    private readonly timeoutMs;
    private readonly waitUntil;
    constructor(opts?: PlaywrightClientOptions);
    private getChromium;
    private getBrowser;
    fetch(req: HttpRequest): Promise<HttpResponse>;
    /** Close the shared browser process. Call when the client is no longer needed. */
    close(): Promise<void>;
}
/**
 * Create a PlaywrightHttpClient, returning null if playwright-core is not
 * installed. Useful for graceful degradation in environments without a browser.
 */
export declare function createPlaywrightClient(opts?: PlaywrightClientOptions): PlaywrightHttpClient | null;
//# sourceMappingURL=playwright.d.ts.map