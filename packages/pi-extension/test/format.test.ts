/**
 * Token-efficiency tests for the web_fetch output formatters.
 *
 * The fixture is deliberately noisy — it mirrors real-world pages that have:
 *   - 30+ navigation links (site menus, footer, breadcrumbs)
 *   - 3 meaningful body links (actual content references)
 *   - Empty metadata (no author, no description, no tags, no publishedAt)
 *   - Rich heading structure already present in the markdown body
 *   - A non-trivial word count
 *
 * Each test asserts that the corresponding formatter:
 *   1. Includes only the fields an agent can act on
 *   2. Excludes fields that are redundant, derivable, or always empty
 *   3. Separates body links from nav-chrome links
 *   4. Produces output that is measurably smaller than a naive full dump
 */

import { describe, expect, it } from "vitest";
import type { SpideredPage } from "@danypops/web-spider";
import {
	bodyLinks,
	highlightHit,
	leanOutput,
	linksOutput,
	markdownOutput,
	navLinksCount,
	omitEmpty,
} from "../src/format.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Generate N nav links simulating a typical site header/footer. */
function makeNavLinks(n: number): SpideredPage["links"] {
	return Array.from({ length: n }, (_, i) => ({
		href: `https://example.com/nav-${i}`,
		text: `Nav Item ${i}`,
		isExternal: false,
		rel: "nav" as const,
	}));
}

const NOISY_PAGE: SpideredPage = {
	url: "https://example.com/how-ai-agents-work",
	domain: "example.com",
	fetchedAt: "2024-06-01T12:00:00Z",
	title: "How AI Agents Work",

	// Empty metadata — common on many pages
	description: "",
	author: "",
	publishedAt: "",
	lang: "en",
	tags: [],

	wordCount: 820,
	readingTimeMinutes: 5, // wordCount / 200 — derivable, not actionable

	headings: [
		{ level: 1, text: "How AI Agents Work" },
		{ level: 2, text: "What is an Agent?" },
		{ level: 2, text: "Memory and State" },
		{ level: 3, text: "Short-term Memory" },
		{ level: 3, text: "Long-term Memory" },
		{ level: 2, text: "Tool Use" },
		{ level: 2, text: "Conclusion" },
	],

	chunks: [
		{ id: "c0", index: 0, heading: "What is an Agent?", text: "An agent is a system that perceives its environment and takes actions.", wordCount: 13, contentType: "text" },
		{ id: "c1", index: 1, heading: "Memory and State", text: "Memory allows agents to retain information across interactions.", wordCount: 10, contentType: "text" },
	],

	links: [
		// 30 nav links — site header, footer, sidebar
		...makeNavLinks(30),
		// 3 body links — actual content references
		{ href: "https://arxiv.org/abs/2309.00864", text: "ReAct paper", isExternal: true, rel: "body" },
		{ href: "https://example.com/memory-in-llms", text: "Memory in LLMs", isExternal: false, rel: "body" },
		{ href: "https://example.com/tool-use", text: "Tool Use survey", isExternal: false, rel: "body" },
	],

	// Headings are already present as ## lines inside the markdown body
	markdown: [
		"# How AI Agents Work",
		"",
		"## What is an Agent?",
		"",
		"An agent is a system that perceives its environment and takes actions.",
		"See the [ReAct paper](https://arxiv.org/abs/2309.00864) for details.",
		"",
		"## Memory and State",
		"",
		"Memory allows agents to retain information across interactions.",
		"Read more in [Memory in LLMs](https://example.com/memory-in-llms).",
		"",
		"### Short-term Memory",
		"",
		"Short-term memory is the working context of an agent.",
		"",
		"### Long-term Memory",
		"",
		"Long-term memory persists across sessions.",
		"",
		"## Tool Use",
		"",
		"Agents use tools to interact with the world. See the [Tool Use survey](https://example.com/tool-use).",
		"",
		"## Conclusion",
		"",
		"AI agents combine perception, memory, and action to solve complex tasks.",
	].join("\n"),
};

// Baseline: what a naive full dump looks like
const NAIVE_DUMP = JSON.stringify(NOISY_PAGE);

// ---------------------------------------------------------------------------
// omitEmpty
// ---------------------------------------------------------------------------

describe("omitEmpty", () => {
	it("removes empty strings", () => {
		const result = omitEmpty({ a: "hello", b: "", c: "world" });
		expect(result).toEqual({ a: "hello", c: "world" });
	});

	it("removes empty arrays", () => {
		const result = omitEmpty({ tags: [], links: ["a"] });
		expect(result).toEqual({ links: ["a"] });
	});

	it("removes undefined", () => {
		const result = omitEmpty({ a: 1, b: undefined });
		expect(result).toEqual({ a: 1 });
	});

	it("removes false", () => {
		const result = omitEmpty({ jsRendered: false, wordCount: 100 });
		expect(result).toEqual({ wordCount: 100 });
	});

	it("keeps 0 — zero is a real value", () => {
		const result = omitEmpty({ count: 0, name: "x" });
		expect(result).toEqual({ count: 0, name: "x" });
	});

	it("keeps null — null is a real value", () => {
		const result = omitEmpty({ val: null, name: "x" });
		expect(result).toEqual({ val: null, name: "x" });
	});
});

// ---------------------------------------------------------------------------
// Link splitting
// ---------------------------------------------------------------------------

describe("bodyLinks / navLinksCount", () => {
	it("extracts only body links", () => {
		const bl = bodyLinks(NOISY_PAGE);
		expect(bl).toHaveLength(3);
		expect(bl.every((l) => !l.hasOwnProperty("rel"))).toBe(true);
		expect(bl.map((l) => l.href)).toContain("https://arxiv.org/abs/2309.00864");
	});

	it("counts nav links correctly", () => {
		expect(navLinksCount(NOISY_PAGE)).toBe(30);
	});

	it("body + nav accounts for all links", () => {
		expect(bodyLinks(NOISY_PAGE).length + navLinksCount(NOISY_PAGE)).toBe(NOISY_PAGE.links.length);
	});
});

// ---------------------------------------------------------------------------
// leanOutput
// ---------------------------------------------------------------------------

describe("leanOutput", () => {
	const out = leanOutput(NOISY_PAGE);

	it("includes essential identity fields", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
		expect(out.wordCount).toBe(NOISY_PAGE.wordCount);
	});

	it("includes headings as flat markdown strings", () => {
		expect(Array.isArray(out.headings)).toBe(true);
		const headings = out.headings as string[];
		expect(headings[0]).toBe("# How AI Agents Work");
		expect(headings[1]).toBe("## What is an Agent?");
		expect(headings[3]).toBe("### Short-term Memory");
	});

	it("includes only body links, not the nav flood", () => {
		const bl = out.bodyLinks as Array<{ href: string; text: string }>;
		expect(Array.isArray(bl)).toBe(true);
		expect(bl).toHaveLength(3);
	});

	it("surfaces nav count instead of nav links", () => {
		expect(out.navLinksCount).toBe(30);
		expect(out).not.toHaveProperty("links");
	});

	it("omits empty metadata fields", () => {
		expect(out).not.toHaveProperty("description");
		expect(out).not.toHaveProperty("author");
		expect(out).not.toHaveProperty("publishedAt");
		expect(out).not.toHaveProperty("tags");
	});

	it("omits derivable and non-actionable fields", () => {
		expect(out).not.toHaveProperty("domain");
		expect(out).not.toHaveProperty("readingTimeMinutes");
		expect(out).not.toHaveProperty("fetchedAt");
		expect(out).not.toHaveProperty("lang");
	});

	it("omits prose body fields", () => {
		expect(out).not.toHaveProperty("markdown");
		expect(out).not.toHaveProperty("chunks");
	});

	it("omits jsRendered when false", () => {
		expect(out).not.toHaveProperty("jsRendered");
	});

	it("includes jsRendered when true", () => {
		const jsPage = { ...NOISY_PAGE, jsRendered: true };
		const jsOut = leanOutput(jsPage);
		expect(jsOut.jsRendered).toBe(true);
	});

	it("is materially smaller than a naive full dump", () => {
		const leanSize = JSON.stringify(out).length;
		// The naive dump includes 30 full link objects, all markdown, all chunks.
		// Lean should be well under half.
		expect(leanSize).toBeLessThan(NAIVE_DUMP.length * 0.5);
	});
});

// ---------------------------------------------------------------------------
// markdownOutput
// ---------------------------------------------------------------------------

describe("markdownOutput", () => {
	const out = markdownOutput(NOISY_PAGE);

	it("includes essential fields for reading", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
		expect(out.wordCount).toBe(NOISY_PAGE.wordCount);
		expect(out.markdown).toBe(NOISY_PAGE.markdown);
	});

	it("omits headings — they are already in the markdown body", () => {
		expect(out).not.toHaveProperty("headings");
	});

	it("omits domain — derivable from url", () => {
		expect(out).not.toHaveProperty("domain");
	});

	it("omits readingTimeMinutes — not actionable", () => {
		expect(out).not.toHaveProperty("readingTimeMinutes");
	});

	it("omits links — not needed when reading prose", () => {
		expect(out).not.toHaveProperty("links");
	});

	it("omits internal fields", () => {
		expect(out).not.toHaveProperty("chunks");
		expect(out).not.toHaveProperty("fetchedAt");
		expect(out).not.toHaveProperty("lang");
	});

	it("omits empty metadata fields", () => {
		expect(out).not.toHaveProperty("description");
		expect(out).not.toHaveProperty("author");
		expect(out).not.toHaveProperty("publishedAt");
		expect(out).not.toHaveProperty("tags");
	});

	it("includes non-empty metadata fields", () => {
		const richPage = { ...NOISY_PAGE, author: "Jane Smith", description: "A guide to AI agents." };
		const richOut = markdownOutput(richPage);
		expect(richOut.author).toBe("Jane Smith");
		expect(richOut.description).toBe("A guide to AI agents.");
	});

	it("is materially smaller than a naive full dump", () => {
		const size = JSON.stringify(out).length;
		// Markdown output has the body text but not chunks, links, or redundant metadata.
		expect(size).toBeLessThan(NAIVE_DUMP.length * 0.8);
	});
});

// ---------------------------------------------------------------------------
// linksOutput
// ---------------------------------------------------------------------------

describe("linksOutput", () => {
	const out = linksOutput(NOISY_PAGE);

	it("includes url and title", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
	});

	it("returns only body links", () => {
		const bl = out.bodyLinks as Array<{ href: string; text: string }>;
		expect(bl).toHaveLength(3);
	});

	it("surfaces nav count, not nav links", () => {
		expect(out.navLinksCount).toBe(30);
		expect(out).not.toHaveProperty("links");
	});

	it("omits navLinksCount when there are no nav links", () => {
		const noNavPage = {
			...NOISY_PAGE,
			links: NOISY_PAGE.links.filter((l) => l.rel === "body"),
		};
		const out2 = linksOutput(noNavPage);
		expect(out2).not.toHaveProperty("navLinksCount");
	});
});

// ---------------------------------------------------------------------------
// highlightHit
// ---------------------------------------------------------------------------

describe("highlightHit", () => {
	const hit = {
		heading: "Memory and State",
		score: 0.87,
		snippet: "Memory allows agents to retain",
		chunkId: "c1",
	};

	it("returns the full chunk text, not the snippet", () => {
		const result = highlightHit(hit, NOISY_PAGE.chunks);
		expect(result.text).toBe(NOISY_PAGE.chunks[1]!.text);
		// snippet is a substring of text — including both would be redundant
		expect(result).not.toHaveProperty("snippet");
	});

	it("falls back to snippet when chunkId is not found", () => {
		const result = highlightHit({ ...hit, chunkId: "missing" }, NOISY_PAGE.chunks);
		expect(result.text).toBe(hit.snippet);
	});

	it("falls back to snippet when chunkId is absent", () => {
		const { chunkId: _, ...noId } = hit;
		const result = highlightHit(noId as typeof hit, NOISY_PAGE.chunks);
		expect(result.text).toBe(hit.snippet);
	});

	it("omits heading when empty", () => {
		const result = highlightHit({ ...hit, heading: "" }, NOISY_PAGE.chunks);
		expect(result).not.toHaveProperty("heading");
	});

	it("includes heading when present", () => {
		const result = highlightHit(hit, NOISY_PAGE.chunks);
		expect(result.heading).toBe("Memory and State");
	});
});
