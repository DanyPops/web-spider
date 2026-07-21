import { describe, expect, test } from "bun:test";
import type { SpideredPage, WebSearchResult } from "@danypops/web-spider";
import { pageToPapyrusDoc, searchResultToPapyrusDoc } from "../src/papyrus-mapping.ts";

function page(overrides: Partial<SpideredPage> = {}): SpideredPage {
	return {
		url: "https://a.example/article",
		domain: "a.example",
		fetchedAt: "2026-01-01T00:00:00.000Z",
		title: "Article Title",
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 100,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: [],
		markdown: "",
		...overrides,
	};
}

describe("pageToPapyrusDoc", () => {
	test("subtype is 'web', not the earlier 'scraped-page'", () => {
		expect(pageToPapyrusDoc(page()).subtype).toBe("web");
	});

	test("title falls back to the url when the page has no title", () => {
		expect(pageToPapyrusDoc(page({ title: "" })).title).toBe("https://a.example/article");
	});

	test("labels carry source, domain, and tags", () => {
		const doc = pageToPapyrusDoc(page({ tags: ["ai", "agents"] }));
		expect(doc.labels).toEqual(["source:web-spider", "domain:a.example", "tag:ai", "tag:agents"]);
	});

	test("body combines description, truncated markdown, and a heading outline", () => {
		const doc = pageToPapyrusDoc(page({
			description: "A short description.",
			markdown: "# Title\n\nBody text.",
			headings: [{ level: 1, text: "Title" }],
		}));
		expect(doc.body).toContain("A short description.");
		expect(doc.body).toContain("Body text.");
		expect(doc.body).toContain("# Title");
	});

	test("markdown is truncated at 4000 characters with an ellipsis", () => {
		const longMarkdown = "x".repeat(5_000);
		const doc = pageToPapyrusDoc(page({ markdown: longMarkdown }));
		expect(doc.body.length).toBeLessThan(longMarkdown.length);
		expect(doc.body.endsWith("…")).toBe(true);
	});

	test("extra carries bounded provenance fields and omits empty ones", () => {
		const doc = pageToPapyrusDoc(page({ author: "", canonicalUrl: undefined, wordCount: 42 }));
		expect(doc.extra).not.toHaveProperty("author");
		expect(doc.extra).not.toHaveProperty("canonicalUrl");
		expect(doc.extra).toMatchObject({ url: "https://a.example/article", wordCount: 42 });
	});

	test("never includes markdown/chunks/images verbatim as separate fields — only the composed body", () => {
		const doc = pageToPapyrusDoc(page({ markdown: "some body" }));
		expect(doc).not.toHaveProperty("markdown");
		expect(doc).not.toHaveProperty("chunks");
	});
});

describe("searchResultToPapyrusDoc", () => {
	const result: WebSearchResult = { url: "https://a.example/hit", title: "Hit Title", snippet: "A snippet of the result." };

	test("subtype is 'web-search-result'", () => {
		expect(searchResultToPapyrusDoc(result, { query: "q" }).subtype).toBe("web-search-result");
	});

	test("title falls back to the url when the result has no title", () => {
		expect(searchResultToPapyrusDoc({ ...result, title: "" }, { query: "q" }).title).toBe("https://a.example/hit");
	});

	test("body is the snippet", () => {
		expect(searchResultToPapyrusDoc(result, { query: "q" }).body).toBe("A snippet of the result.");
	});

	test("labels carry source and the result's domain", () => {
		expect(searchResultToPapyrusDoc(result, { query: "q" }).labels).toEqual(["source:web-spider", "domain:a.example"]);
	});

	test("extra carries the query, optional engine, and optional publishedAt", () => {
		const doc = searchResultToPapyrusDoc({ ...result, publishedAt: "2026-01-01" }, { query: "rate limiting", engine: "tavily" });
		expect(doc.extra).toEqual({ url: "https://a.example/hit", query: "rate limiting", engine: "tavily", publishedAt: "2026-01-01" });
	});

	test("omits engine from extra when not supplied", () => {
		const doc = searchResultToPapyrusDoc(result, { query: "q" });
		expect(doc.extra).not.toHaveProperty("engine");
	});
});
