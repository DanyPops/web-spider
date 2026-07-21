import { describe, expect, test } from "bun:test";
import {
	formatCacheListResult,
	formatCacheSearchResult,
	formatFetchResult,
	formatSearchResult,
} from "../src/cli-format.ts";

describe("formatFetchResult", () => {
	test("robots-blocked result", () => {
		expect(formatFetchResult({ blocked: true, url: "https://x.test", reason: "robots.txt" })).toBe("Blocked by robots.txt — https://x.test");
	});

	test("tree path miss", () => {
		expect(formatFetchResult({ found: false, path: "a.b[0]" })).toBe('No node at path "a.b[0]"');
	});

	test("crawl summary with errors and a note", () => {
		const text = formatFetchResult({
			pagesFound: 2,
			errors: 1,
			note: "All pages cached.",
			pages: [{ title: "One", url: "https://a.test" }, { title: "Two", url: "https://b.test" }],
		});
		expect(text).toContain("Crawled 2 pages");
		expect(text).toContain("1 error(s)");
		expect(text).toContain("One");
		expect(text).toContain("https://a.test");
		expect(text).toContain("All pages cached.");
	});

	test("highlights hits (heading/score/text)", () => {
		const text = formatFetchResult({ hits: [{ heading: "Install", score: 0.91, text: "Run npm install" }] });
		expect(text).toContain("Install");
		expect(text).toContain("Run npm install");
		expect(text).toContain("0.91");
	});

	test("empty highlights hits", () => {
		expect(formatFetchResult({ hits: [] })).toBe("No matches.");
	});

	test("tree query hits (path/tag/snippet)", () => {
		const text = formatFetchResult({ hits: [{ path: "article.pre[0]", tag: "pre", score: 0.5, snippet: "npm i" }] });
		expect(text).toContain("article.pre[0]");
		expect(text).toContain("(pre)");
		expect(text).toContain("npm i");
	});

	test("tree node result", () => {
		expect(formatFetchResult({ tag: "code", path: "article.code", text: "npm install" })).toBe("article.code <code>\nnpm install");
	});

	test("links format", () => {
		const text = formatFetchResult({ title: "Docs", bodyLinks: [{ text: "Guide", href: "https://docs.test/guide" }] });
		expect(text).toContain("Docs");
		expect(text).toContain("Guide");
		expect(text).toContain("https://docs.test/guide");
	});

	test("links format with no body links", () => {
		expect(formatFetchResult({ title: "Docs", bodyLinks: [] })).toContain("no body links");
	});

	test("markdown format truncates long bodies with a --json hint", () => {
		const longBody = "x".repeat(600);
		const text = formatFetchResult({ title: "Article", wordCount: 100, cache: "hit", markdown: longBody });
		expect(text).toContain("Article");
		expect(text).toContain("100 words");
		expect(text).toContain("cache hit");
		expect(text).toContain("use --json for the full body");
		expect(text.length).toBeLessThan(longBody.length + 200);
	});

	test("markdown format leaves short bodies intact", () => {
		const text = formatFetchResult({ title: "Article", markdown: "short body" });
		expect(text).toContain("short body");
		expect(text).not.toContain("--json");
	});

	test("lean format (headings, no markdown)", () => {
		const text = formatFetchResult({ title: "Lean", wordCount: 42, headings: ["# Lean", "## Section"] });
		expect(text).toContain("Lean");
		expect(text).toContain("42 words");
		expect(text).toContain("## Section");
	});

	test("unrecognized shape falls back to compact JSON", () => {
		expect(formatFetchResult({ weird: true })).toBe(JSON.stringify({ weird: true }));
	});
});

describe("formatSearchResult", () => {
	test("no results", () => {
		expect(formatSearchResult({ query: "q", results: [] })).toBe('No results for "q".');
	});

	test("lists title/url/snippet per result", () => {
		const text = formatSearchResult({ query: "q", results: [{ url: "https://r.test", title: "R", snippet: "s" }] });
		expect(text).toContain("1 result(s)");
		expect(text).toContain("R");
		expect(text).toContain("https://r.test");
		expect(text).toContain("s");
	});
});

describe("formatCacheListResult", () => {
	test("empty cache", () => {
		expect(formatCacheListResult({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] })).toBe("No cached pages.");
	});

	test("reports filtered vs. total when a grep narrows the result", () => {
		const text = formatCacheListResult({ total: 5, filtered: 1, offset: 0, limit: 20, pages: [{ url: "https://a.test", domain: "a.test", title: "A", description: "", wordCount: 1, fetchedAt: 0, expiresAt: 0 }] });
		expect(text).toContain("1 of 5");
	});
});

describe("formatCacheSearchResult", () => {
	test("no hits", () => {
		expect(formatCacheSearchResult({ query: "q", pagesSearched: 3, hits: [] })).toBe('No matches for "q" across 3 cached page(s).');
	});

	test("lists ranked hits", () => {
		const text = formatCacheSearchResult({ query: "q", pagesSearched: 2, hits: [{ url: "https://a.test", title: "A", score: 0.8, heading: "Intro", text: "hello" }] });
		expect(text).toContain("1 hit(s)");
		expect(text).toContain("A");
		expect(text).toContain("Intro");
		expect(text).toContain("hello");
	});
});
