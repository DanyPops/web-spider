import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createQuotesDetails,
	createQuotesResult,
	parseQuotesDetails,
	QuotesResultCard,
	renderWebQuotesCall,
	renderWebQuotesResult,
} from "../src/quotes-presentation.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
} as unknown as Theme;

const render = (result: ReturnType<typeof createQuotesResult>, expanded = false, width = 80) =>
	renderWebQuotesResult(result, { expanded, isPartial: false }, theme, { isPartial: false, lastComponent: undefined })
		.render(width)
		.join("\n");

function resource(url: string, quoteText: string, citationUrl: string) {
	return { url, title: "Some Title", quotes: [{ heading: "Section", score: 0.9, text: quoteText, citationUrl }] };
}

describe("web_quotes dual-channel presentation", () => {
	it("keeps full quote text in the bounded model channel, never dumped raw into the collapsed presentation", () => {
		const resources = [
			resource("https://example.com/a", "a real verbatim quote about clock synchronization", "https://example.com/a#:~:text=x"),
		];
		const payload = { query: "clock synchronization", urlsRequested: 1, resources };
		const result = createQuotesResult(payload, createQuotesDetails("clock synchronization", resources));

		expect(JSON.parse(result.content[0].text)).toMatchObject({ query: "clock synchronization" });
		expect(render(result)).not.toContain("a real verbatim quote about clock synchronization");
		expect(render(result, true)).toContain("a real verbatim quote about clock synchronization");
	});

	it("truncates an oversized model channel instead of ever exceeding the bound, and marks it truncated", () => {
		const bigQuote = "clock synchronization detail ".repeat(5_000);
		const resources = [resource("https://example.com/a", bigQuote, "https://example.com/a#:~:text=x")];
		const payload = { query: "clock synchronization", urlsRequested: 1, resources };
		const result = createQuotesResult(payload, createQuotesDetails("clock synchronization", resources));

		expect(result.content[0].text.length).toBeLessThanOrEqual(50_000);
		expect(result.details.truncated).toBe(true);
		expect(result.details.complete).toBe(false);
		expect(JSON.stringify(result.details)).not.toContain("clock synchronization detail");
	});

	it("renders a compact call summary instead of echoing the full urls list", () => {
		const text = renderWebQuotesCall({ query: "clock sync", urls: ["https://a.test", "https://b.test"] }, theme)
			.render(100)
			.join("\n");
		expect(text).toContain("Quotes");
		expect(text).toContain("clock sync");
		expect(text).toContain("2");
	});

	it("summarizes quote/error counts when collapsed and shows per-resource previews", () => {
		const resources = [
			resource("https://example.com/good", "a matching quote here", "https://example.com/good#:~:text=x"),
			{ url: "https://example.com/bad", error: "HTTP 404 Not Found" },
		];
		const payload = { query: "q", urlsRequested: 2, errors: 1, errorUrls: ["https://example.com/bad"], resources };
		const result = createQuotesResult(payload, createQuotesDetails("q", resources));

		const collapsed = render(result);
		expect(collapsed).toContain("1 quote");
		expect(collapsed).toContain("1 error");
		expect(collapsed).not.toContain("a matching quote here");

		for (const width of [40, 80, 120]) {
			const lines = renderWebQuotesResult(result, { expanded: true, isPartial: false }, theme, {
				isPartial: false,
				lastComponent: undefined,
			}).render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("round-trips valid details and rejects a malformed/legacy replay", () => {
		const details = createQuotesDetails("q", [resource("https://example.com/a", "text", "https://example.com/a#:~:text=x")]);
		expect(parseQuotesDetails(details)).toBeDefined();
		expect(parseQuotesDetails({ version: 999, kind: "web-quotes" })).toBeUndefined();
		expect(parseQuotesDetails(undefined)).toBeUndefined();
		expect(parseQuotesDetails({ kind: "web" })).toBeUndefined();
	});

	it("shows partial activity while a call is still in flight", () => {
		const partial = renderWebQuotesResult(
			{ content: [{ type: "text" as const, text: "" }], details: createQuotesDetails("q", []) },
			{ expanded: false, isPartial: true },
			theme,
			{ isPartial: true, lastComponent: undefined },
		)
			.render(40)
			.join("\n");
		expect(partial).toContain("Finding quotes");
	});

	it("falls back safely for legacy/unknown details shapes instead of throwing", () => {
		const fallback = renderWebQuotesResult(
			{ content: [{ type: "text" as const, text: "legacy bounded content" }], details: { schema: "unknown/v99" } },
			{ expanded: false, isPartial: false },
			theme,
			{ isPartial: false, lastComponent: undefined },
		)
			.render(40)
			.join("\n");
		expect(fallback).toContain("legacy bounded content");
	});

	it("reuses context.lastComponent across renders instead of reallocating", () => {
		const first = createQuotesResult(
			{ query: "a", urlsRequested: 1, resources: [resource("https://example.com/a", "alpha text", "https://example.com/a#:~:text=x")] },
			createQuotesDetails("a", [resource("https://example.com/a", "alpha text", "https://example.com/a#:~:text=x")]),
		);
		const component = renderWebQuotesResult(first, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: undefined,
		});
		expect(component).toBeInstanceOf(QuotesResultCard);

		const second = createQuotesResult(
			{ query: "b", urlsRequested: 1, resources: [resource("https://example.com/b", "beta text", "https://example.com/b#:~:text=x")] },
			createQuotesDetails("b", [resource("https://example.com/b", "beta text", "https://example.com/b#:~:text=x")]),
		);
		const reused = renderWebQuotesResult(second, { expanded: false, isPartial: false }, theme, {
			isPartial: false,
			lastComponent: component,
		});
		expect(reused).toBe(component);
	});

	it("renderWebQuotesCall reuses a lastComponent Text instance instead of allocating a new one", () => {
		const previous = new Text("", 0, 0);
		const reused = renderWebQuotesCall({ query: "q", urls: ["https://a.test"] }, theme, { lastComponent: previous });
		expect(reused).toBe(previous);
	});
});
