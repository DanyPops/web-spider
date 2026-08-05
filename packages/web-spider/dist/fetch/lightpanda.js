export class LightpandaHttpClient {
    constructor(opts) {
        this.browser = null;
        if (!opts.endpoint)
            throw new Error("LightpandaHttpClient requires an explicit endpoint — none is assumed or auto-discovered");
        this.endpoint = opts.endpoint;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }
    async getBrowser() {
        if (this.browser?.isConnected())
            return this.browser;
        const { chromium } = await import("playwright-core");
        this.browser = await chromium.connectOverCDP(this.endpoint);
        return this.browser;
    }
    async fetch(req) {
        const browser = await this.getBrowser();
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const page = await context.newPage();
        page.on("console", () => { });
        page.on("pageerror", () => { });
        try {
            const response = await page.goto(req.url, {
                timeout: this.timeoutMs,
                waitUntil: "networkidle",
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
            const html = await page.content();
            const headers = await response.allHeaders();
            return {
                ok: status >= 200 && status < 300,
                status,
                statusText: response.statusText(),
                headers: { get: (name) => headers[name.toLowerCase()] ?? null },
                text: async () => html,
                arrayBuffer: async () => {
                    const buf = await response.body();
                    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
            };
        }
        finally {
            await page.close();
        }
    }
    /**
     * Closes this client's Playwright-side connection only — never the
     * remote Lightpanda process itself, which this client never started and
     * does not own the lifecycle of.
     */
    async close() {
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
export function createLightpandaClient(opts = {}) {
    const endpoint = opts.endpoint ?? process.env.WEB_SPIDER_LIGHTPANDA_ENDPOINT;
    if (!endpoint)
        return null;
    try {
        return new LightpandaHttpClient({ endpoint, timeoutMs: opts.timeoutMs });
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=lightpanda.js.map