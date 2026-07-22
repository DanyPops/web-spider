/**
 * Integration tests: spider()'s preferLlmsTxt option end to end, not just
 * the standalone probeLlmsTxt unit (see llms-txt.test.ts). No real network.
 */
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

function stubClient(routes: Record<string, { status: number; contentType: string | null; body: string }>): IHttpClient {
	return {
		async fetch(req) {
			const route = routes[req.url];
			if (!route) return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			return {
				ok: route.status >= 200 && route.status < 300,
				status: route.status,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? route.contentType : null) },
				text: async () => route.body,
				arrayBuffer: async () => new TextEncoder().encode(route.body).buffer as ArrayBuffer,
			};
		},
	};
}

describe("spider() — preferLlmsTxt", () => {
	it("when found, returns a page built from llms.txt instead of the requested URL's own HTML", async () => {
		const httpClient = stubClient({
			"https://docs.example.com/llms.txt": {
				status: 200,
				contentType: "text/plain; charset=utf-8",
				body: "# Example Docs\n\n## Guides\n\n- [Getting Started](https://docs.example.com/start)",
			},
			"https://docs.example.com/some/deep/page": {
				status: 200,
				contentType: "text/html",
				body: "<html><head><title>Should never be fetched</title></head><body>real page</body></html>",
			},
		});
		const page = await spider("https://docs.example.com/some/deep/page", { httpClient, preferLlmsTxt: true });
		expect(page.url).toBe("https://docs.example.com/llms.txt");
		expect(page.viaStrategy).toBe("llms.txt");
		expect(page.markdown).toContain("# Example Docs");
		expect(page.headings).toEqual([
			{ level: 1, text: "Example Docs" },
			{ level: 2, text: "Guides" },
		]);
	});

	it("falls through to the normal fetch path unchanged when llms.txt is not found", async () => {
		const httpClient = stubClient({
			"https://example.com/page": {
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: "<html><head><title>Real Page</title></head><body><article><p>Real content, long enough for Readability's extraction heuristics to actually treat this as a genuine article body rather than boilerplate.</p></article></body></html>",
			},
			// no https://example.com/llms.txt route -> 404 via the stub's default
		});
		const page = await spider("https://example.com/page", { httpClient, preferLlmsTxt: true });
		expect(page.url).toBe("https://example.com/page");
		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("Real Page");
	});

	it("is fully opt-in: default behavior (preferLlmsTxt unset) never probes llms.txt at all", async () => {
		let probedLlmsTxt = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url.endsWith("/llms.txt")) probedLlmsTxt = true;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => "<html><head><title>Hi</title></head><body><article><p>Some real content here, long enough to be treated as a genuine article body by Readability's heuristics.</p></article></body></html>",
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};
		const page = await spider("https://example.com/page", { httpClient });
		expect(probedLlmsTxt).toBe(false);
		expect(page.viaStrategy).toBeUndefined();
	});

	it("works for the lean view too", async () => {
		const httpClient = stubClient({
			"https://docs.example.com/llms.txt": { status: 200, contentType: "text/plain", body: "# Index\n\nSome text." },
		});
		const lean = await spider("https://docs.example.com/anything", { httpClient, preferLlmsTxt: true, view: "lean" });
		expect(lean.view).toBe("lean");
		expect(lean.url).toBe("https://docs.example.com/llms.txt");
		expect(lean.viaStrategy).toBe("llms.txt");
	});
});
