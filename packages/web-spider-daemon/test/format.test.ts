/**
 * Token-efficiency tests for format.ts's output formatters — ported verbatim
 * from packages/pi-extension/test/format.test.ts (vitest → bun:test) now
 * that format.ts's canonical home is this daemon package; the pi-extension
 * copy is deleted once the extension-client task makes it consume daemon
 * operation outputs directly instead of formatting pages itself.
 *
 * The fixture is deliberately noisy — it mirrors real-world pages that have:
 *   - 30+ navigation links (site menus, footer, breadcrumbs)
 *   - 3 meaningful body links (actual content references)
 *   - Empty metadata (no author, no description, no tags, no publishedAt)
 *   - Rich heading structure already present in the markdown body
 *   - A non-trivial word count
 */

import { describe, expect, test } from "bun:test";
import type { SpideredPage } from "@danypops/web-spider";
import {
	bodyLinks,
	highlightHit,
	leanOutput,
	linksOutput,
	markdownOutput,
	navLinksCount,
	omitEmpty,
} from "../src/format.ts";

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

	description: "",
	author: "",
	publishedAt: "",
	lang: "en",
	tags: [],

	wordCount: 820,
	readingTimeMinutes: 5,

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
		...makeNavLinks(30),
		{ href: "https://arxiv.org/abs/2309.00864", text: "ReAct paper", isExternal: true, rel: "body" },
		{ href: "https://example.com/memory-in-llms", text: "Memory in LLMs", isExternal: false, rel: "body" },
		{ href: "https://example.com/tool-use", text: "Tool Use survey", isExternal: false, rel: "body" },
	],

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

const NAIVE_DUMP = JSON.stringify(NOISY_PAGE);

describe("omitEmpty", () => {
	test("removes empty strings", () => {
		expect(omitEmpty({ a: "hello", b: "", c: "world" })).toEqual({ a: "hello", c: "world" });
	});
	test("removes empty arrays", () => {
		expect(omitEmpty({ tags: [], links: ["a"] })).toEqual({ links: ["a"] });
	});
	test("removes undefined", () => {
		expect(omitEmpty({ a: 1, b: undefined })).toEqual({ a: 1 });
	});
	test("removes false", () => {
		expect(omitEmpty({ jsRendered: false, wordCount: 100 })).toEqual({ wordCount: 100 });
	});
	test("keeps 0 — zero is a real value", () => {
		expect(omitEmpty({ count: 0, name: "x" })).toEqual({ count: 0, name: "x" });
	});
	test("keeps null — null is a real value", () => {
		expect(omitEmpty({ val: null, name: "x" })).toEqual({ val: null, name: "x" });
	});
});

describe("bodyLinks / navLinksCount", () => {
	test("extracts only body links", () => {
		const bl = bodyLinks(NOISY_PAGE);
		expect(bl).toHaveLength(3);
		expect(bl.every((l) => !Object.hasOwn(l, "rel"))).toBe(true);
		expect(bl.map((l) => l.href)).toContain("https://arxiv.org/abs/2309.00864");
	});
	test("counts nav links correctly", () => {
		expect(navLinksCount(NOISY_PAGE)).toBe(30);
	});
	test("body + nav accounts for all links", () => {
		expect(bodyLinks(NOISY_PAGE).length + navLinksCount(NOISY_PAGE)).toBe(NOISY_PAGE.links.length);
	});
});

describe("leanOutput", () => {
	const out = leanOutput(NOISY_PAGE);

	test("includes essential identity fields", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
		expect(out.wordCount).toBe(NOISY_PAGE.wordCount);
	});
	test("includes headings as flat markdown strings", () => {
		expect(Array.isArray(out.headings)).toBe(true);
		const headings = out.headings as string[];
		expect(headings[0]).toBe("# How AI Agents Work");
		expect(headings[1]).toBe("## What is an Agent?");
		expect(headings[3]).toBe("### Short-term Memory");
	});
	test("includes only body links, not the nav flood", () => {
		const bl = out.bodyLinks as Array<{ href: string; text: string }>;
		expect(Array.isArray(bl)).toBe(true);
		expect(bl).toHaveLength(3);
	});
	test("surfaces nav count instead of nav links", () => {
		expect(out.navLinksCount).toBe(30);
		expect(out).not.toHaveProperty("links");
	});
	test("omits empty metadata fields", () => {
		expect(out).not.toHaveProperty("description");
		expect(out).not.toHaveProperty("author");
		expect(out).not.toHaveProperty("publishedAt");
		expect(out).not.toHaveProperty("tags");
	});
	test("omits derivable and non-actionable fields", () => {
		expect(out).not.toHaveProperty("domain");
		expect(out).not.toHaveProperty("readingTimeMinutes");
		expect(out).not.toHaveProperty("fetchedAt");
		expect(out).not.toHaveProperty("lang");
	});
	test("omits prose body fields", () => {
		expect(out).not.toHaveProperty("markdown");
		expect(out).not.toHaveProperty("chunks");
	});
	test("omits jsRendered when false", () => {
		expect(out).not.toHaveProperty("jsRendered");
	});
	test("includes jsRendered when true", () => {
		const jsOut = leanOutput({ ...NOISY_PAGE, jsRendered: true });
		expect(jsOut.jsRendered).toBe(true);
	});
	test("is materially smaller than a naive full dump", () => {
		expect(JSON.stringify(out).length).toBeLessThan(NAIVE_DUMP.length * 0.5);
	});
});

describe("markdownOutput", () => {
	const out = markdownOutput(NOISY_PAGE);

	test("includes essential fields for reading", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
		expect(out.wordCount).toBe(NOISY_PAGE.wordCount);
		expect(out.markdown).toBe(NOISY_PAGE.markdown);
	});
	test("omits headings — they are already in the markdown body", () => {
		expect(out).not.toHaveProperty("headings");
	});
	test("omits domain — derivable from url", () => {
		expect(out).not.toHaveProperty("domain");
	});
	test("omits readingTimeMinutes — not actionable", () => {
		expect(out).not.toHaveProperty("readingTimeMinutes");
	});
	test("omits links — not needed when reading prose", () => {
		expect(out).not.toHaveProperty("links");
	});
	test("omits internal fields", () => {
		expect(out).not.toHaveProperty("chunks");
		expect(out).not.toHaveProperty("fetchedAt");
		expect(out).not.toHaveProperty("lang");
	});
	test("omits empty metadata fields", () => {
		expect(out).not.toHaveProperty("description");
		expect(out).not.toHaveProperty("author");
		expect(out).not.toHaveProperty("publishedAt");
		expect(out).not.toHaveProperty("tags");
	});
	test("includes non-empty metadata fields", () => {
		const richOut = markdownOutput({ ...NOISY_PAGE, author: "Jane Smith", description: "A guide to AI agents." });
		expect(richOut.author).toBe("Jane Smith");
		expect(richOut.description).toBe("A guide to AI agents.");
	});
	test("is materially smaller than a naive full dump", () => {
		expect(JSON.stringify(out).length).toBeLessThan(NAIVE_DUMP.length * 0.8);
	});
});

describe("linksOutput", () => {
	const out = linksOutput(NOISY_PAGE);

	test("includes url and title", () => {
		expect(out.url).toBe(NOISY_PAGE.url);
		expect(out.title).toBe(NOISY_PAGE.title);
	});
	test("returns only body links", () => {
		const bl = out.bodyLinks as Array<{ href: string; text: string }>;
		expect(bl).toHaveLength(3);
	});
	test("surfaces nav count, not nav links", () => {
		expect(out.navLinksCount).toBe(30);
		expect(out).not.toHaveProperty("links");
	});
	test("omits navLinksCount when there are no nav links", () => {
		const noNavPage = { ...NOISY_PAGE, links: NOISY_PAGE.links.filter((l) => l.rel === "body") };
		expect(linksOutput(noNavPage)).not.toHaveProperty("navLinksCount");
	});
});

describe("highlightHit", () => {
	const hit = { heading: "Memory and State", score: 0.87, snippet: "Memory allows agents to retain", chunkId: "c1" };

	test("returns the full chunk text, not the snippet", () => {
		const result = highlightHit(hit, NOISY_PAGE.chunks);
		expect(result.text).toBe(NOISY_PAGE.chunks[1]?.text);
		expect(result).not.toHaveProperty("snippet");
	});
	test("falls back to snippet when chunkId is not found", () => {
		const result = highlightHit({ ...hit, chunkId: "missing" }, NOISY_PAGE.chunks);
		expect(result.text).toBe(hit.snippet);
	});
	test("falls back to snippet when chunkId is absent", () => {
		const { chunkId: _chunkId, ...noId } = hit;
		const result = highlightHit(noId as typeof hit, NOISY_PAGE.chunks);
		expect(result.text).toBe(hit.snippet);
	});
	test("omits heading when empty", () => {
		expect(highlightHit({ ...hit, heading: "" }, NOISY_PAGE.chunks)).not.toHaveProperty("heading");
	});
	test("includes heading when present", () => {
		expect(highlightHit(hit, NOISY_PAGE.chunks).heading).toBe("Memory and State");
	});
});
