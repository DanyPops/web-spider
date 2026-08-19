import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createWebDetails,
	createWebResult,
	parseWebDetails,
	renderWebFetchCall,
	renderWebFetchResult,
	type WebFormat,
	WebResultCard,
} from "../src/presentation.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as unknown as Theme;

const render = (result: ReturnType<typeof createWebResult>, expanded = false, width = 80) =>
	renderWebFetchResult(result, { expanded, isPartial: false }, theme, { isPartial: false, lastComponent: undefined })
		.render(width)
		.join("\n");

describe("web_fetch dual-channel presentation", () => {
	it("keeps requested primary content only in the bounded model channel", () => {
		const body = "article body ".repeat(10_000);
		const result = createWebResult(
			{ url: "https://example.com/article", title: "Article", markdown: body },
			createWebDetails({ operation: "fetch", format: "markdown", url: "https://example.com/article", title: "Article" }),
		);
		expect(result.content[0].text.length).toBeLessThanOrEqual(50_000);
		expect(JSON.parse(result.content[0].text)).toMatchObject({ truncated: true });
		expect(JSON.stringify(result.details)).not.toContain("article body");
		expect(result.details.truncated).toBe(true);
		expect(result.details.complete).toBe(false);
		expect(parseWebDetails(result.details)?.operation).toBe("fetch");
	});

	it("renders compact calls for search, fetch, crawl, cache, and tree actions", () => {
		const cases = [
			[{ searchQuery: "Pi extensions" }, "Search · Pi extensions"],
			[{ url: "https://example.com", depth: 2 }, "Crawl · example.com · depth 2"],
			[{ url: "https://example.com", format: "tree", query: "install" }, "Tree query · example.com · install"],
			[{ url: "https://example.com", format: "tree", path: "article.pre[0]" }, "Tree path · example.com · article.pre[0]"],
			[{ query: "cache terms" }, "Cache search · cache terms"],
			[{ grep: "docs" }, "Cache list · docs"],
			[{ url: "https://example.com", format: "links" }, "Fetch links · example.com"],
		] as const;
		for (const [args, expected] of cases) {
			expect(renderWebFetchCall(args, theme).render(100).join("\n")).toContain(expected);
		}
	});

	it("renders metadata when collapsed and canonical primary content when expanded", () => {
		const result = createWebResult(
			{ url: "https://example.com", title: "Example", markdown: "# Heading\n\nPrimary body" },
			createWebDetails({
				operation: "fetch",
				format: "markdown",
				url: "https://example.com",
				title: "Example",
				wordCount: 2,
				cache: "hit",
			}),
		);
		expect(render(result)).toContain("Fetched markdown · Example · 2 words · cache hit");
		expect(render(result)).not.toContain("Primary body");
		expect(render(result)).toContain("expand for details");
		expect(render(result, true)).not.toContain("expand for details");
		expect(render(result, true)).toContain("Primary body");
		expect(JSON.stringify(result.details)).not.toContain("Primary body");
		for (const width of [40, 80, 120]) {
			const lines = renderWebFetchResult(result, { expanded: true, isPartial: false }, theme, { isPartial: false }).render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("renders bounded identities for search, crawl, cache, links, highlights, and tree", () => {
		const variants = [
			createWebResult(
				{ query: "q", results: [{ title: "Result", url: "https://r.test", snippet: "Evidence" }] },
				createWebDetails({
					operation: "search",
					format: "search",
					query: "q",
					hits: 1,
					items: [{ title: "Result", url: "https://r.test" }],
				}),
			),
			createWebResult(
				{ pagesFound: 2, pages: [{ title: "One", url: "https://one.test" }] },
				createWebDetails({ operation: "crawl", format: "lean", pages: 2, items: [{ title: "One", url: "https://one.test" }] }),
			),
			createWebResult(
				{ total: 2, pages: [{ title: "Cached", url: "https://cache.test" }] },
				createWebDetails({ operation: "cache-list", format: "lean", pages: 2, items: [{ title: "Cached", url: "https://cache.test" }] }),
			),
			createWebResult(
				{ bodyLinks: [{ text: "Docs", href: "https://docs.test" }] },
				createWebDetails({ operation: "fetch", format: "links", links: 1, items: [{ title: "Docs", url: "https://docs.test" }] }),
			),
			createWebResult(
				{ hits: [{ heading: "Install", score: 1, text: "Evidence" }] },
				createWebDetails({ operation: "fetch", format: "highlights", hits: 1, query: "install" }),
			),
			createWebResult(
				{ tag: "code", path: "article.code", text: "npm install" },
				createWebDetails({ operation: "tree-path", format: "tree", path: "article.code" }),
			),
		];
		for (const result of variants) {
			expect(render(result).length).toBeGreaterThan(0);
			expect(render(result, true)).not.toContain("[object Object]");
		}
	});

	// QoL: a real, live incident -- every url/href in an identity/highlight/link row was plain dim
	// text, unreachable from the TUI. hyperlink() wraps it in an OSC 8 escape sequence (falls back
	// to plain text automatically on a terminal without OSC 8 support) so an end user can actually
	// open it, matching the same fix applied to Tickets' Ref column and detail-view footer.
	it("QoL: wraps every identity/highlight/link row's own url/href in a clickable OSC 8 hyperlink", () => {
		const search = createWebResult(
			{ query: "q", results: [{ title: "Result", url: "https://r.test", snippet: "Evidence" }] },
			createWebDetails({ operation: "search", format: "search", query: "q", hits: 1, items: [{ title: "Result", url: "https://r.test" }] }),
		);
		const expanded = render(search, true);
		expect(expanded).toContain("\x1b]8;;https://r.test\x1b\\https://r.test\x1b]8;;\x1b\\");

		const links = createWebResult(
			{ bodyLinks: [{ text: "Docs", href: "https://docs.test" }] },
			createWebDetails({ operation: "fetch", format: "links", links: 1, items: [{ title: "Docs", url: "https://docs.test" }] }),
		);
		expect(render(links, true)).toContain("\x1b]8;;https://docs.test\x1b\\https://docs.test\x1b]8;;\x1b\\");

		const highlights = createWebResult(
			{ hits: [{ heading: "Install", score: 1, text: "Evidence", url: "https://install.test" }] },
			createWebDetails({ operation: "fetch", format: "highlights", hits: 1, query: "install" }),
		);
		expect(render(highlights, true)).toContain("\x1b]8;;https://install.test\x1b\\https://install.test\x1b]8;;\x1b\\");
	});

	// Regression for doc 4e9e08c1 Finding 1: every non-"markdown" WebFormat's expanded view used
	// to be indistinguishable from `JSON.stringify(payload, null, 2)` -- primaryLines() special-cased
	// only "markdown". One representative real payload shape per declared WebFormat value, asserting
	// the expanded render is never textually equal to a raw JSON dump of its own payload.
	it("renders every declared WebFormat value's expanded view as more than a raw JSON dump", () => {
		const cases: Array<{ format: WebFormat; payload: unknown }> = [
			{ format: "markdown", payload: { url: "https://example.com", title: "Example", markdown: "# Heading\n\nBody text." } },
			{
				format: "search",
				payload: { query: "q", results: [{ title: "Result", url: "https://r.test", snippet: "Evidence snippet" }] },
			},
			{
				format: "lean",
				payload: { title: "Example", description: "A page.", headings: ["## Intro", "## Details"], wordCount: 120 },
			},
			{ format: "links", payload: { bodyLinks: [{ text: "Docs", href: "https://docs.test" }] } },
			{ format: "highlights", payload: { hits: [{ heading: "Install", score: 0.9, text: "npm install foo" }] } },
			{ format: "tree", payload: { tag: "article", path: "article", text: "npm install", children: [] } },
			{ format: "source", payload: { url: "https://example.com", contentType: "text/html", content: "Normalized text.", complete: true } },
			{
				format: "meta",
				payload: { url: "https://example.com", openGraph: { "og:title": "Example" }, twitterCard: { "twitter:card": "summary" } },
			},
		];
		const nonRaw: WebFormat[] = [];
		for (const { format, payload } of cases) {
			const result = createWebResult(payload, createWebDetails({ operation: "fetch", format }));
			const expanded = render(result, true, 80);
			const rawJson = JSON.stringify(payload, null, 2);
			if (expanded.replace(/\s+/g, "") !== rawJson.replace(/\s+/g, "")) nonRaw.push(format);
		}
		expect(
			nonRaw,
			`formats that still collapse to a raw JSON dump: ${cases.map((c) => c.format).filter((f) => !nonRaw.includes(f))}`,
		).toEqual(cases.map((c) => c.format));
	});

	it("represents robots denial without treating it as successful fetched content", () => {
		const result = createWebResult(
			{ blocked: true, url: "https://example.com/private", reason: "robots.txt", hint: "Try another source." },
			createWebDetails({
				operation: "fetch",
				format: "markdown",
				url: "https://example.com/private",
				status: "blocked",
				blockedBy: "robots.txt",
			}),
		);
		expect(render(result)).toContain("Blocked by robots.txt");
		expect(result.details.status).toBe("blocked");
	});

	it("falls back safely for legacy details and shows partial activity", () => {
		const fallback = renderWebFetchResult(
			{ content: [{ type: "text" as const, text: "legacy bounded content" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{ isPartial: false },
		)
			.render(40)
			.join("\n");
		expect(fallback).toContain("legacy bounded content");
		const malformed: unknown = { ...createWebDetails({ operation: "fetch", format: "lean" }), cache: "credential-bearing-unbounded-state" };
		expect(parseWebDetails(malformed)).toBeUndefined();
		const partial = renderWebFetchResult(
			{ content: [{ type: "text" as const, text: "" }], details: createWebDetails({ operation: "search", format: "search", query: "q" }) },
			{ expanded: false, isPartial: true },
			theme,
			{ isPartial: true, lastComponent: undefined },
		)
			.render(40)
			.join("\n");
		expect(partial).toContain("Searching");
	});

	it("reuses context.lastComponent across renders (Pi's documented component-reuse best practice)", () => {
		const first = createWebResult(
			{ url: "https://example.com/a", title: "Alpha", markdown: "alpha body" },
			createWebDetails({ operation: "fetch", format: "markdown", url: "https://example.com/a", title: "Alpha", wordCount: 2 }),
		);
		const component = renderWebFetchResult(first, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: undefined,
		});
		expect(component).toBeInstanceOf(WebResultCard);
		expect(component.render(80).join("\n")).toContain("Alpha");

		const second = createWebResult(
			{ url: "https://example.com/b", title: "Beta", markdown: "beta body" },
			createWebDetails({ operation: "fetch", format: "markdown", url: "https://example.com/b", title: "Beta", wordCount: 2 }),
		);
		const reused = renderWebFetchResult(second, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: component,
		});
		expect(reused).toBe(component); // same object identity — updated in place, not reallocated
		expect(reused.render(80).join("\n")).toContain("Beta");
		expect(reused.render(80).join("\n")).not.toContain("Alpha");
	});

	it("does not reuse a lastComponent of a different shape (falls back to constructing fresh)", () => {
		const result = createWebResult(
			{ url: "https://example.com", title: "Example", markdown: "body" },
			createWebDetails({ operation: "fetch", format: "markdown", url: "https://example.com", title: "Example" }),
		);
		const unrelated = new Text("unrelated", 0, 0);
		const component = renderWebFetchResult(result, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: unrelated,
		});
		expect(component).not.toBe(unrelated);
		expect(component).toBeInstanceOf(WebResultCard);
	});

	it("clears cached render lines on invalidate() so a later render reflects updated state", () => {
		const result = createWebResult(
			{ url: "https://example.com", title: "Cached", markdown: "body" },
			createWebDetails({ operation: "fetch", format: "markdown", url: "https://example.com", title: "Cached" }),
		);
		const component = renderWebFetchResult(result, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: undefined,
		}) as WebResultCard;
		const first = component.render(80);
		const second = component.render(80); // same width — must return the cached array, not merely equal content
		expect(second).toBe(first);
		component.invalidate();
		const third = component.render(80);
		expect(third).not.toBe(first); // cache was cleared; a fresh array was computed
		expect(third.join("\n")).toBe(first.join("\n")); // content is unchanged — only identity differs
	});

	it("renderWebFetchCall reuses a lastComponent Text instance instead of allocating a new one", () => {
		const previous = new Text("", 0, 0);
		const reused = renderWebFetchCall({ url: "https://example.com" }, theme, { lastComponent: previous });
		expect(reused).toBe(previous);
		expect(reused.render(100).join("\n")).toContain("example.com");

		const fresh = renderWebFetchCall({ url: "https://example.com" }, theme, { lastComponent: undefined });
		expect(fresh).not.toBe(previous);
	});
});
