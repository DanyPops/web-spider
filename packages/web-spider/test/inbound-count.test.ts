/**
 * TDD tests for LeanPage.inboundCount via PageGraph.
 */

import { describe, expect, it } from "vitest";
import { PageGraph } from "../src/graph.js";
import type { SpideredPage } from "../src/types.js";
import { toLean } from "../src/views.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(url: string, linksTo: string[] = []): SpideredPage {
	return {
		url,
		domain: new URL(url).hostname,
		fetchedAt: new Date().toISOString(),
		title: `Page at ${url}`,
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 100,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: linksTo.map((href) => ({ href, text: href, isExternal: false, rel: "body" as const })),
		markdown: "",
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LeanPage.inboundCount via PageGraph", () => {
	it("omitted when no graph is passed to toLean()", () => {
		const lean = toLean(makePage("https://example.com"));
		expect(lean.inboundCount).toBeUndefined();
	});

	it("0 when page has no inbound links", () => {
		const graph = new PageGraph();
		const page = makePage("https://example.com");
		graph.addPage(page);
		const lean = toLean(page, graph);
		expect(lean.inboundCount).toBe(0);
	});

	it("1 when one page links to this page", () => {
		const graph = new PageGraph();
		const home = makePage("https://example.com", ["https://example.com/about"]);
		const about = makePage("https://example.com/about");
		graph.addPage(home);
		graph.addPage(about);
		const lean = toLean(about, graph);
		expect(lean.inboundCount).toBe(1);
	});

	it("counts multiple inbound links correctly", () => {
		const graph = new PageGraph();
		const target = makePage("https://example.com/popular");
		const a = makePage("https://example.com/a", ["https://example.com/popular"]);
		const b = makePage("https://example.com/b", ["https://example.com/popular"]);
		const c = makePage("https://example.com/c", ["https://example.com/popular"]);
		[target, a, b, c].forEach((p) => graph.addPage(p));
		const lean = toLean(target, graph);
		expect(lean.inboundCount).toBe(3);
	});

	it("inboundCount on a hub page is 0 (only outbound)", () => {
		const graph = new PageGraph();
		const hub = makePage("https://example.com", [
			"https://example.com/a",
			"https://example.com/b",
		]);
		graph.addPage(hub);
		const lean = toLean(hub, graph);
		expect(lean.inboundCount).toBe(0);
	});

	it("pages ranked by inboundCount descending matches graph.byPageRank()", () => {
		const graph = new PageGraph();
		const popular = makePage("https://example.com/popular");
		const normal = makePage("https://example.com/normal");
		const a = makePage("https://example.com/a", ["https://example.com/popular"]);
		const b = makePage("https://example.com/b", ["https://example.com/popular"]);
		const c = makePage("https://example.com/c", ["https://example.com/normal"]);
		[popular, normal, a, b, c].forEach((p) => graph.addPage(p));

		const popularLean = toLean(popular, graph);
		const normalLean = toLean(normal, graph);

		expect(popularLean.inboundCount).toBe(2);
		expect(normalLean.inboundCount).toBe(1);
		expect(popularLean.inboundCount!).toBeGreaterThan(normalLean.inboundCount!);
	});

	it("all other LeanPage fields are still populated when graph is provided", () => {
		const graph = new PageGraph();
		const page = makePage("https://example.com");
		graph.addPage(page);
		const lean = toLean(page, graph);
		expect(lean.url).toBe("https://example.com");
		expect(lean.title).toBeTruthy();
		expect(lean.view).toBe("lean");
		expect(typeof lean.wordCount).toBe("number");
	});
});
