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
// Module-level flag: stealth is wired to the playwright-extra chromium
// singleton once and stays active for the lifetime of the process.
let stealthApplied = false;
export class PlaywrightHttpClient {
    constructor(opts = {}) {
        this.browser = null;
        this.channel = opts.channel ?? "chrome";
        this.executablePath = opts.executablePath ?? "";
        this.timeoutMs = opts.timeoutMs ?? 30_000;
        this.waitUntil = opts.waitUntil ?? "networkidle";
        this.captureImages = opts.captureImages ?? false;
    }
    async getChromium() {
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
        }
        catch {
            const { chromium } = await import("playwright-core");
            return chromium;
        }
    }
    async getBrowser() {
        if (this.browser?.isConnected())
            return this.browser;
        const chromium = await this.getChromium();
        // --disable-dev-shm-usage: Chromium's default /dev/shm is often too small in a
        // container/CI sandbox, and exhausting it OOM-kills the renderer -- routes shared
        // memory through /tmp instead, which uses the container's normal memory budget.
        const launchOpts = this.executablePath
            ? { executablePath: this.executablePath, headless: true, args: ["--disable-dev-shm-usage"] }
            : { channel: this.channel, headless: true, args: ["--disable-dev-shm-usage"] };
        this.browser = await chromium.launch(launchOpts);
        return this.browser;
    }
    async fetch(req) {
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        // Suppress browser-side console output and JS errors — they are not
        // useful to the caller and would leak into Pi's TUI stream.
        page.on("console", () => { });
        page.on("pageerror", () => { });
        try {
            // Block fonts always (never needed for HTML extraction).
            // Block images and media during page navigation for speed — unless
            // this is a direct image fetch (Accept: image/*), in which case
            // captureImages:true lets it through so fetchImages() can retrieve
            // the binary via arrayBuffer().
            await page.route("**/*", (route) => {
                const type = route.request().resourceType();
                const accept = route.request().headers().accept ?? "";
                const isImageFetch = accept.startsWith("image/");
                if (type === "font") {
                    route.abort();
                }
                else if (["image", "media"].includes(type) && !(this.captureImages && isImageFetch)) {
                    route.abort();
                }
                else {
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
            const status = response.status();
            // page.content() returns the full serialised DOM after JS execution.
            const html = await page.content();
            const headers = await response.allHeaders();
            const contentType = headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
            let bytes = new TextEncoder().encode(html);
            // response.body() is unavailable after page.close(), so materialize any
            // binary response while this adapter still owns the page. Keep rendered
            // HTML as the byte representation for SPAs instead of regressing to the
            // pre-JavaScript network body.
            if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
                try {
                    const body = await response.body();
                    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
                }
                catch {
                    // Some navigation responses expose no retrievable body. The rendered
                    // document remains a safe structural fallback.
                }
            }
            return {
                ok: status >= 200 && status < 300,
                status,
                statusText: response.statusText(),
                headers: { get: (name) => headers[name.toLowerCase()] ?? null },
                text: async () => html,
                arrayBuffer: async () => bytes.slice().buffer,
            };
        }
        finally {
            await page.close();
        }
    }
    /** Close the shared browser process. Call when the client is no longer needed. */
    async close() {
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
export function createPlaywrightClient(opts) {
    try {
        return new PlaywrightHttpClient(opts);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=playwright.js.map