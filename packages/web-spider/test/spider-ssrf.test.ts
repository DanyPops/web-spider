/**
 * spider()/crawl() end to end against the real default HTTP client (no
 * httpClient override) -- proves the SSRF guard is actually wired in, not
 * just unit-tested in isolation.
 */
import { describe, expect, it } from "vitest";
import { crawl } from "../src/crawl/crawl.js";
import { SsrfBlockedError } from "../src/errors.js";
import { spider } from "../src/fetch/spider.js";
import { DefaultSsrfGuard } from "../src/fetch/ssrf-guard.js";

describe("spider() -- SSRF guard wired into the default HTTP client", () => {
	it("refuses a cloud-metadata target with no httpClient override", async () => {
		await expect(spider("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("refuses a loopback target", async () => {
		await expect(spider("http://127.0.0.1:9/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("a caller-supplied ssrfGuard with allowRanges lets a normally-blocked target proceed to the real fetch attempt", async () => {
		const guard = new DefaultSsrfGuard({ allowRanges: ["127.0.0.1/32"] });
		// Nothing listens on this port -- expect a connection failure, not SsrfBlockedError,
		// proving the guard let it through before the real network attempt.
		await expect(spider("http://127.0.0.1:9/", { ssrfGuard: guard, timeoutMs: 500 })).rejects.not.toBeInstanceOf(SsrfBlockedError);
	});
});

describe("crawl() -- SSRF guard also covers the default sitemap fetch", () => {
	it("does not crash and does not leak a real network attempt when start URL resolves to a blocked target", async () => {
		const result = await crawl("http://127.0.0.1:9/", { maxDepth: 0, useSitemap: true });
		expect(result.errors.get("http://127.0.0.1:9/")).toBeInstanceOf(SsrfBlockedError);
	});
});
