/**
 * Regression tests for a real bug found via dogfooding: spider() threw an
 * opaque Readability internal error ("First argument to Readability
 * constructor should be a document object") when fetching a real
 * text/plain URL (https://docs.browser-use.com/llms.txt) that this site's
 * own docs explicitly recommend LLMs fetch. No real network — a stub
 * IHttpClient serves each Content-Type directly.
 */
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

function stubClient(contentType: string, body: string): IHttpClient {
	return {
		async fetch() {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
				text: async () => body,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
			};
		},
	};
}

describe("spider() — non-HTML content types", () => {
	it("text/plain: returns the raw body directly instead of throwing (the original bug)", async () => {
		const httpClient = stubClient("text/plain; charset=utf-8", "Just some plain text.\nSecond line.");
		const page = await spider("https://docs.browser-use.com/llms.txt", { httpClient });
		expect(page.markdown).toBe("Just some plain text.\nSecond line.");
		expect(page.contentType).toBe("text/plain; charset=utf-8");
		expect(page.wordCount).toBe(6);
		// No HTML was ever parsed -- title falls back to the URL's last path segment.
		expect(page.title).toBe("llms.txt");
	});

	it("application/json: pretty-prints parseable JSON", async () => {
		const httpClient = stubClient("application/json", '{"a":1,"b":[2,3]}');
		const page = await spider("https://example.com/data.json", { httpClient });
		expect(page.markdown).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
		expect(page.contentType).toBe("application/json");
	});

	it("application/json: falls back to raw text for unparseable JSON rather than guessing", async () => {
		const httpClient = stubClient("application/json", "{not valid json");
		const page = await spider("https://example.com/broken.json", { httpClient });
		expect(page.markdown).toBe("{not valid json");
	});

	it("application/ld+json (the +json suffix convention): treated as json, not unsupported", async () => {
		const httpClient = stubClient("application/ld+json", '{"@context":"https://schema.org"}');
		const page = await spider("https://example.com/ld.json", { httpClient });
		expect(page.markdown).toContain("@context");
		expect(page.contentType).toBe("application/ld+json");
	});

	it("text/markdown: extracts a real heading outline using the #/##/### convention", async () => {
		const httpClient = stubClient("text/markdown", "# Title\n\nSome intro text.\n\n## Section One\n\nMore text.");
		const page = await spider("https://example.com/readme.md", { httpClient });
		expect(page.headings).toEqual([
			{ level: 1, text: "Title" },
			{ level: 2, text: "Section One" },
		]);
	});

	it("text/xml (RSS/Atom-shaped): returned as raw text, not thrown", async () => {
		const httpClient = stubClient("application/rss+xml", "<rss><channel><title>Feed</title></channel></rss>");
		const page = await spider("https://example.com/feed.xml", { httpClient });
		expect(page.markdown).toContain("<rss>");
		expect(page.contentType).toBe("application/rss+xml");
	});

	it("unsupported binary content types throw a clean, actionable error instead of an internal library error", async () => {
		const httpClient = stubClient("image/png", "not real png bytes, doesn't matter");
		await expect(spider("https://example.com/photo.png", { httpClient })).rejects.toThrow(
			/Cannot extract content.*image\/png/,
		);
	});

	it("never throws the original opaque Readability constructor error for any classified content type", async () => {
		for (const contentType of ["text/plain", "application/json", "application/xml", "text/csv"]) {
			const httpClient = stubClient(contentType, "some content");
			await expect(spider("https://example.com/x", { httpClient })).resolves.toBeDefined();
		}
	});

	it("lean view: returns a valid LeanPage for non-HTML content, not a crash", async () => {
		const httpClient = stubClient("text/plain", "hello world");
		const lean = await spider("https://example.com/x.txt", { httpClient, view: "lean" });
		expect(lean.view).toBe("lean");
		expect(lean.wordCount).toBe(2);
		expect(lean.links).toEqual([]);
		expect(lean.contentType).toBe("text/plain");
	});

	it("tree view: returns a single-node text tree for non-HTML content, not a crash", async () => {
		const httpClient = stubClient("text/plain", "hello world");
		const tree = await spider("https://example.com/x.txt", { httpClient, view: "tree" });
		expect(tree.view).toBe("tree");
		expect(tree.tree).toEqual({ tag: "text", path: "text", text: "hello world" });
	});

	it("ordinary HTML is completely unaffected: no contentType field appears at all", async () => {
		const httpClient = stubClient("text/html; charset=utf-8", "<html><head><title>Hi</title></head><body><article><h1>Hi</h1><p>Real content, long enough to count as an article body for readability's extraction heuristics to actually kick in here.</p></article></body></html>");
		const page = await spider("https://example.com/article", { httpClient });
		expect(page.contentType).toBeUndefined();
		expect(page.title).toBe("Hi");
	});
});
