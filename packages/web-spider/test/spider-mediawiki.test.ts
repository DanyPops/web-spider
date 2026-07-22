/**
 * Integration tests: spider()'s preferMediaWiki option end to end, not just
 * the standalone mediawiki.ts units (mediawiki.test.ts). No real network.
 */
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

function stubClient(jsonRoutes: Record<string, unknown>, htmlRoutes: Record<string, string> = {}): IHttpClient {
	return {
		async fetch(req) {
			if (req.url in jsonRoutes) {
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
					text: async () => JSON.stringify(jsonRoutes[req.url]),
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			if (req.url in htmlRoutes) {
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => htmlRoutes[req.url],
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
		},
	};
}

describe("spider() — preferMediaWiki", () => {
	it("when the site is MediaWiki, queries the real API instead of scraping the rendered page", async () => {
		const httpClient = stubClient({
			"https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json": {
				query: { general: { generator: "MediaWiki 1.47.0-wmf.11", sitename: "Wikipedia" } },
			},
			"https://en.wikipedia.org/w/api.php?action=parse&page=Example&prop=text&format=json&redirects=1": {
				parse: { title: "Example", text: { "*": "<p>Real article content, long enough for Readability's heuristics to treat this as a genuine article body rather than boilerplate noise.</p>" } },
			},
		});
		const page = await spider("https://en.wikipedia.org/wiki/Example", { httpClient, preferMediaWiki: true });
		expect(page.url).toBe("https://en.wikipedia.org/wiki/Example"); // unchanged -- same resource, different mechanism
		expect(page.viaStrategy).toBe("mediawiki");
		expect(page.title).toBe("Example");
		expect(page.markdown).toContain("Real article content");
	});

	it("falls through to the normal fetch path unchanged when the URL isn't an article (no title extractable)", async () => {
		const httpClient = stubClient({}, {
			"https://en.wikipedia.org/": "<html><head><title>Wikipedia Home</title></head><body><article><p>Real homepage content, long enough for Readability's heuristics to treat this as a genuine article body.</p></article></body></html>",
		});
		const page = await spider("https://en.wikipedia.org/", { httpClient, preferMediaWiki: true });
		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("Wikipedia Home");
	});

	it("falls through to the normal fetch path unchanged when the site isn't MediaWiki-based at all", async () => {
		const httpClient = stubClient({}, {
			"https://example.com/wiki/Something": "<html><head><title>Not A Wiki</title></head><body><article><p>Real content here, long enough for Readability's extraction heuristics to actually kick in.</p></article></body></html>",
		});
		const page = await spider("https://example.com/wiki/Something", { httpClient, preferMediaWiki: true });
		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("Not A Wiki");
	});

	it("is fully opt-in: default behavior never probes the MediaWiki API at all", async () => {
		let probedApi = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url.includes("api.php")) probedApi = true;
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => "<html><head><title>Hi</title></head><body><article><p>Some real content here, long enough to be treated as a genuine article body.</p></article></body></html>",
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};
		const page = await spider("https://en.wikipedia.org/wiki/Example", { httpClient });
		expect(probedApi).toBe(false);
		expect(page.viaStrategy).toBeUndefined();
	});

	it("works for the lean view too", async () => {
		const httpClient = stubClient({
			"https://wiki.archlinux.org/api.php?action=query&meta=siteinfo&format=json": {
				query: { general: { generator: "MediaWiki 1.46.0", sitename: "ArchWiki" } },
			},
			"https://wiki.archlinux.org/api.php?action=parse&page=Installation_guide&prop=text&format=json&redirects=1": {
				parse: { title: "Installation guide", text: { "*": "<p>Real ArchWiki content, long enough for the extraction heuristics.</p>" } },
			},
		});
		const lean = await spider("https://wiki.archlinux.org/title/Installation_guide", { httpClient, preferMediaWiki: true, view: "lean" });
		expect(lean.view).toBe("lean");
		expect(lean.viaStrategy).toBe("mediawiki");
		expect(lean.url).toBe("https://wiki.archlinux.org/title/Installation_guide");
	});
});
