import { describe, expect, it } from "vitest";
import { spider } from "../src/fetch/spider.js";
import type { IHttpClient } from "../src/ports.js";

function responseClient(contentType: string, body: string): IHttpClient {
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

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head><title>Characterized page</title><meta name="description" content="Pinned description"></head>
<body>
  <p>Outside the selected root must not survive.</p>
  <main id="target">
    <article>
      <h1>Kept heading</h1>
      <p class="remove">Excluded words must not survive.</p>
      <p>${"Kept article words for stable readability and chunk conversion. ".repeat(45)}</p>
      <h2>Second section</h2>
      <p>${"More characterized article content. ".repeat(45)}</p>
      <a href="/kept">Kept link</a>
    </article>
  </main>
</body>
</html>`;

describe("response extraction behavior before the Strategy refactor", () => {
	it("pins HTML full, lean, and tree views with selectors", async () => {
		const options = {
			httpClient: responseClient("text/html; charset=utf-8", ARTICLE_HTML),
			rootSelector: "#target",
			excludeSelectors: ".remove",
		};
		const full = await spider("https://example.com/article", options);
		const lean = await spider("https://example.com/article", { ...options, view: "lean" });
		const tree = await spider("https://example.com/article", { ...options, view: "tree" });

		expect(full).toMatchObject({
			url: "https://example.com/article",
			domain: "example.com",
			title: "Characterized page",
			description: "Pinned description",
			lang: "en",
			headings: [
				{ level: 2, text: "Kept heading" },
				{ level: 2, text: "Second section" },
			],
		});
		expect(full.markdown).toContain("Kept article words");
		expect(full.markdown).not.toContain("Excluded words");
		expect(full.markdown).not.toContain("Outside the selected root");
		expect(lean).toMatchObject({ view: "lean", title: "Characterized page", headings: ["## Kept heading", "## Second section"] });
		expect(tree.view).toBe("tree");
		expect(JSON.stringify(tree.tree)).toContain("Kept heading");
	});

	it("pins chunk-aware token budgeting", async () => {
		const httpClient = responseClient("text/html", ARTICLE_HTML);
		const complete = await spider("https://example.com/article", { httpClient });
		const bounded = await spider("https://example.com/article", { httpClient, tokenBudget: 50 });

		expect(complete.chunks.length).toBeGreaterThan(1);
		expect(bounded.chunks.length).toBeLessThan(complete.chunks.length);
		expect(bounded.markdown).toBe(bounded.chunks.map((part) => part.text).join("\n\n"));
	});

	it("pins textual and JSON conversion without a DOM", async () => {
		const text = await spider("https://example.com/readme.txt", {
			httpClient: responseClient("text/plain", "# Plain title\n\nPlain body"),
		});
		const json = await spider("https://example.com/data.json", {
			httpClient: responseClient("application/json", '{"answer":42,"items":[1,2]}'),
		});

		expect(text).toMatchObject({
			title: "readme.txt",
			contentType: "text/plain",
			headings: [{ level: 1, text: "Plain title" }],
			markdown: "# Plain title\n\nPlain body",
		});
		expect(json).toMatchObject({
			title: "data.json",
			contentType: "application/json",
			markdown: '{\n  "answer": 42,\n  "items": [\n    1,\n    2\n  ]\n}',
		});
	});
});
