/**
 * Integration tests: spider()'s preferMarkdownVariant option end to end,
 * not just the standalone probeMarkdownVariant unit (markdown-suffix.test.ts).
 * No real network.
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

describe("spider() — preferMarkdownVariant", () => {
	it("when found, returns the .md sibling instead of fetching the requested HTML page at all", async () => {
		let htmlPageFetched = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url === "https://docs.aws.amazon.com/x/Welcome.md") {
					return {
						ok: true, status: 200, statusText: "OK",
						headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/markdown; charset=utf-8" : null) },
						text: async () => "# Welcome to S3\n\nReal markdown content, straight from the source.",
						arrayBuffer: async () => new ArrayBuffer(0),
					};
				}
				if (req.url === "https://docs.aws.amazon.com/x/Welcome.html") {
					htmlPageFetched = true;
					return { ok: true, status: 200, statusText: "OK", headers: { get: () => "text/html" }, text: async () => "<html>should never be fetched</html>", arrayBuffer: async () => new ArrayBuffer(0) };
				}
				return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			},
		};
		const page = await spider("https://docs.aws.amazon.com/x/Welcome.html", { httpClient, preferMarkdownVariant: true });
		expect(page.url).toBe("https://docs.aws.amazon.com/x/Welcome.md");
		expect(page.viaStrategy).toBe("markdown-suffix");
		expect(page.markdown).toContain("# Welcome to S3");
		expect(htmlPageFetched).toBe(false); // the whole point: the HTML page is never fetched on a hit
	});

	it("falls through to the normal fetch path unchanged when no .md sibling exists", async () => {
		const httpClient = stubClient({
			"https://example.com/page.html": {
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: "<html><head><title>Real Page</title></head><body><article><p>Real content, long enough for Readability's extraction heuristics to treat this as a genuine article body.</p></article></body></html>",
			},
			// no .md sibling route -> 404 via the stub's default
		});
		const page = await spider("https://example.com/page.html", { httpClient, preferMarkdownVariant: true });
		expect(page.url).toBe("https://example.com/page.html");
		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("Real Page");
	});

	it("is fully opt-in: default behavior never probes a .md variant at all", async () => {
		let probedMd = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url.endsWith(".md")) probedMd = true;
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => "<html><head><title>Hi</title></head><body><article><p>Some real content here, long enough to be treated as a genuine article body.</p></article></body></html>",
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};
		const page = await spider("https://example.com/page.html", { httpClient });
		expect(probedMd).toBe(false);
		expect(page.viaStrategy).toBeUndefined();
	});

	it("preferLlmsTxt is checked first: a llms.txt hit short-circuits before the .md-suffix probe ever runs", async () => {
		let probedMd = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url.endsWith(".md")) probedMd = true;
				if (req.url === "https://docs.example.com/llms.txt") {
					return { ok: true, status: 200, statusText: "OK", headers: { get: () => "text/plain" }, text: async () => "# Index", arrayBuffer: async () => new ArrayBuffer(0) };
				}
				return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			},
		};
		const page = await spider("https://docs.example.com/page.html", { httpClient, preferLlmsTxt: true, preferMarkdownVariant: true });
		expect(page.viaStrategy).toBe("llms.txt");
		expect(probedMd).toBe(false);
	});
});
