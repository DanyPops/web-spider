/**
 * Unit tests for spider.ts internals and agent-ergonomic behaviour.
 * These tests do not make real HTTP requests.
 */

import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Escape suppression — no backslash noise in output
// ---------------------------------------------------------------------------

describe("turndown escape suppression", () => {
	it("does not escape square brackets", () => {
		const td = new TurndownService();
		(td as unknown as { escape: (s: string) => string }).escape = (s) => s;
		const html = "<p>See [[wikilinks]] and [[another]]</p>";
		const md = td.turndown(html);
		expect(md).not.toContain("\\[");
		expect(md).toContain("[[wikilinks]]");
	});

	it("does not escape asterisks", () => {
		const td = new TurndownService();
		(td as unknown as { escape: (s: string) => string }).escape = (s) => s;
		const html = "<p>The **bold** word</p>";
		const md = td.turndown(html);
		// Turndown converts <strong> to **, but plain text ** should not become \*\*
		expect(md).not.toContain("\\*");
	});

	it("does not escape backticks in plain text", () => {
		const td = new TurndownService();
		(td as unknown as { escape: (s: string) => string }).escape = (s) => s;
		const html = "<p>Use `code` here</p>";
		const md = td.turndown(html);
		expect(md).not.toContain("\\`");
	});
});

// ---------------------------------------------------------------------------
// Image stripping — no alt-text noise
// ---------------------------------------------------------------------------

describe("image stripping", () => {
	it("removes img tags from output", () => {
		const td = new TurndownService();
		(td as unknown as { escape: (s: string) => string }).escape = (s) => s;
		td.addRule("strip-images", { filter: "img", replacement: () => "" });

		const html = `<p>Before</p><img src="photo.jpg" alt="A nice photo"><p>After</p>`;
		const md = td.turndown(html);
		expect(md).not.toContain("photo.jpg");
		expect(md).not.toContain("A nice photo");
		expect(md).toContain("Before");
		expect(md).toContain("After");
	});
});

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

// Re-implement the pure function locally so we can test it without importing
// the whole spider module (which has side effects at module init time).
function detectContentType(lines: string[]): string {
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		if (t.startsWith("```")) return "code";
		if (t.startsWith("|")) return "table";
		if (/^[-*+] /.test(t) || /^\d+\. /.test(t)) return "list";
		if (t.startsWith(">")) return "blockquote";
		return "text";
	}
	return "text";
}

// Re-implement the chunker locally to test code-block and table boundary logic.
const CHUNK_TARGET = 150;
function chunkMarkdown(
	markdown: string,
	_baseUrl = "https://example.com",
): Array<{ text: string; contentType: string; heading: string }> {
	const chunks: Array<{ text: string; contentType: string; heading: string }> = [];
	const lines = markdown.split("\n");
	let heading = "";
	let buffer: string[] = [];
	let inTable = false;
	let inCode = false;

	const flush = () => {
		const text = buffer.join("\n").trim();
		if (!text) return;
		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount < 10) return;
		chunks.push({ text, contentType: detectContentType(buffer), heading });
		buffer = [];
		inTable = false;
	};

	for (const line of lines) {
		if (line.trim().startsWith("```")) inCode = !inCode;
		const isTableRow = line.trim().startsWith("|");
		if (inCode) {
			buffer.push(line);
		} else {
			if (isTableRow) inTable = true;
			else if (inTable && !isTableRow) inTable = false;
			const headingMatch = /^#{1,3} (.+)/.exec(line);
			if (headingMatch && !inTable) {
				const w = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (w >= CHUNK_TARGET) flush();
				heading = headingMatch[1];
				buffer.push(line);
			} else {
				buffer.push(line);
				const w = buffer.join(" ").split(/\s+/).filter(Boolean).length;
				if (w >= CHUNK_TARGET && !inTable) flush();
			}
		}
	}
	flush();
	return chunks;
}

describe("detectContentType", () => {
	it("detects fenced code blocks", () => {
		expect(detectContentType(["```typescript", "const x = 1", "```"])).toBe("code");
	});

	it("detects markdown tables", () => {
		expect(detectContentType(["| Col1 | Col2 |", "| --- | --- |", "| a | b |"])).toBe("table");
	});

	it("detects unordered lists", () => {
		expect(detectContentType(["- item one", "- item two"])).toBe("list");
		expect(detectContentType(["* item", "* item"])).toBe("list");
		expect(detectContentType(["+ item"])).toBe("list");
	});

	it("detects ordered lists", () => {
		expect(detectContentType(["1. first", "2. second"])).toBe("list");
	});

	it("detects blockquotes", () => {
		expect(detectContentType(["> quoted text"])).toBe("blockquote");
	});

	it("defaults to text for prose", () => {
		expect(detectContentType(["This is a normal paragraph."])).toBe("text");
	});

	it("skips blank lines before classifying", () => {
		expect(detectContentType(["", "  ", "| table row |"])).toBe("table");
	});

	it("returns text for empty buffer", () => {
		expect(detectContentType([])).toBe("text");
		expect(detectContentType(["", "  "])).toBe("text");
	});
});

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

function extractTags(doc: Document): string[] {
	const tags = new Set<string>();
	const keywords = doc.querySelector('meta[name="keywords"]')?.getAttribute("content") ?? "";
	for (const k of keywords
		.split(/[,;]/)
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean)) {
		tags.add(k);
	}
	for (const el of [...doc.querySelectorAll('meta[property="article:tag"], meta[name="article:tag"]')]) {
		const t = el.getAttribute("content")?.trim().toLowerCase();
		if (t) tags.add(t);
	}
	return [...tags].slice(0, 20);
}

describe("extractTags", () => {
	it("extracts comma-separated keywords", () => {
		const dom = new JSDOM('<html><head><meta name="keywords" content="scraping, agents, LLM"></head></html>');
		expect(extractTags(dom.window.document)).toEqual(["scraping", "agents", "llm"]);
	});

	it("extracts article:tag properties", () => {
		const dom = new JSDOM(
			"<html><head>" +
				'<meta property="article:tag" content="AI">' +
				'<meta property="article:tag" content="Web">' +
				"</head></html>",
		);
		expect(extractTags(dom.window.document)).toEqual(["ai", "web"]);
	});

	it("deduplicates across sources", () => {
		const dom = new JSDOM(
			"<html><head>" +
				'<meta name="keywords" content="ai, web">' +
				'<meta property="article:tag" content="AI">' +
				"</head></html>",
		);
		const tags = extractTags(dom.window.document);
		// "ai" appears twice (once from keywords, once from article:tag) — should be deduplicated
		expect(tags.filter((t) => t === "ai")).toHaveLength(1);
	});

	it("returns empty array when no tags present", () => {
		const dom = new JSDOM("<html><head></head></html>");
		expect(extractTags(dom.window.document)).toEqual([]);
	});

	it("caps at 20 tags", () => {
		const many = Array.from({ length: 30 }, (_, i) => `tag${i}`).join(",");
		const dom = new JSDOM(`<html><head><meta name="keywords" content="${many}"></head></html>`);
		expect(extractTags(dom.window.document).length).toBeLessThanOrEqual(20);
	});
});

// ---------------------------------------------------------------------------
// Canonical URL extraction
// ---------------------------------------------------------------------------

function extractCanonicalUrl(doc: Document, fetchedUrl: string): string | undefined {
	const canonical =
		doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
		doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
	if (!canonical) return undefined;
	const norm = (u: string) => u.replace(/\/$/, "");
	return norm(canonical) !== norm(fetchedUrl) ? canonical : undefined;
}

describe("extractCanonicalUrl", () => {
	it("extracts link[rel=canonical]", () => {
		const dom = new JSDOM('<html><head><link rel="canonical" href="https://example.com/page"></head></html>');
		expect(extractCanonicalUrl(dom.window.document, "https://example.com/page?ref=social")).toBe(
			"https://example.com/page",
		);
	});

	it("extracts og:url when no canonical link", () => {
		const dom = new JSDOM('<html><head><meta property="og:url" content="https://example.com/og"></head></html>');
		expect(extractCanonicalUrl(dom.window.document, "https://example.com/other")).toBe("https://example.com/og");
	});

	it("returns undefined when canonical matches fetched URL", () => {
		const dom = new JSDOM('<html><head><link rel="canonical" href="https://example.com/page"></head></html>');
		expect(extractCanonicalUrl(dom.window.document, "https://example.com/page")).toBeUndefined();
	});

	it("returns undefined when no canonical", () => {
		const dom = new JSDOM("<html><head></head></html>");
		expect(extractCanonicalUrl(dom.window.document, "https://example.com")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Link rel classification
// ---------------------------------------------------------------------------

function classifyLinkRel(a: Element): "body" | "nav" {
	return a.closest("nav, header, footer, aside") !== null ? "nav" : "body";
}

describe("link rel classification", () => {
	it("classifies links inside <nav> as nav", () => {
		const dom = new JSDOM("<html><body><nav><a href='/x'>link</a></nav></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("nav");
	});

	it("classifies links inside <footer> as nav", () => {
		const dom = new JSDOM("<html><body><footer><a href='/x'>link</a></footer></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("nav");
	});

	it("classifies links inside <header> as nav", () => {
		const dom = new JSDOM("<html><body><header><a href='/x'>link</a></header></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("nav");
	});

	it("classifies links inside <aside> as nav", () => {
		const dom = new JSDOM("<html><body><aside><a href='/x'>link</a></aside></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("nav");
	});

	it("classifies links inside article content as body", () => {
		const dom = new JSDOM("<html><body><article><p><a href='/x'>link</a></p></article></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("body");
	});

	it("classifies bare links as body", () => {
		const dom = new JSDOM("<html><body><p><a href='/x'>link</a></p></body></html>");
		const a = dom.window.document.querySelector("a")!;
		expect(classifyLinkRel(a)).toBe("body");
	});
});

// ---------------------------------------------------------------------------
// Input validation (via thrown error messages — no HTTP needed)
// ---------------------------------------------------------------------------

describe("spider input validation", () => {
	it("rejects non-URL strings", async () => {
		const { spider } = await import("../src/spider.js");
		await expect(spider("not a url")).rejects.toThrow("Invalid URL");
	});

	it("rejects ftp:// protocol", async () => {
		const { spider } = await import("../src/spider.js");
		await expect(spider("ftp://example.com")).rejects.toThrow("Unsupported protocol");
	});

	it("rejects file:// protocol", async () => {
		const { spider } = await import("../src/spider.js");
		await expect(spider("file:///etc/passwd")).rejects.toThrow("Unsupported protocol");
	});
});

// ---------------------------------------------------------------------------
// Code block splitting — fences must never be broken across chunks
// ---------------------------------------------------------------------------

describe("code block splitting", () => {
	// Build a markdown string with a large code block (>150 words of code)
	// followed by more prose to force a flush boundary inside the fence.
	const bigCodeBlock = [
		"## Setup",
		"",
		"Some intro text.",
		"",
		"```typescript",
		// 160 words of fake code — enough to exceed CHUNK_TARGET on its own
		...Array.from({ length: 160 }, (_, i) => `const var${i} = ${i} // line ${i}`),
		"```",
		"",
		"## After the block",
		"",
		"Prose that follows the code block. It should land in its own chunk.",
	].join("\n");

	it("never produces an odd number of fenced code markers", () => {
		const chunks = chunkMarkdown(bigCodeBlock);
		const totalFences = chunks.reduce((n, c) => n + (c.text.match(/```/g) ?? []).length, 0);
		expect(totalFences % 2).toBe(0);
	});

	it("keeps the entire code block in one chunk", () => {
		const chunks = chunkMarkdown(bigCodeBlock);
		// At most one chunk should contain fence markers
		const chunksWithCode = chunks.filter((c) => c.text.includes("```"));
		expect(chunksWithCode.length).toBe(1);
	});

	it("detects contentType=code when a chunk opens directly with a fence (no heading)", () => {
		// A standalone code block with no preceding prose or heading.
		// detectContentType sees the fence as the first non-blank line → 'code'.
		const pureCode = [
			"```typescript",
			...Array.from({ length: 30 }, (_, i) => `const x${i} = ${i}`),
			"```",
			// padding to reach the 10-word minimum for flush
			"some extra words to reach the minimum threshold for flushing the buffer right here",
		].join("\n");
		const chunks = chunkMarkdown(pureCode);
		const codeChunk = chunks.find((c) => c.text.includes("```"));
		expect(codeChunk).toBeDefined();
		expect(codeChunk!.contentType).toBe("code");
	});

	it("contentType is text when a heading precedes the fence in the same chunk", () => {
		// A heading + code block land in the same chunk.
		// detectContentType sees the heading line first → 'text'. This is expected.
		const headingThenCode = [
			"## My Section",
			"```typescript",
			...Array.from({ length: 30 }, (_, i) => `const x${i} = ${i}`),
			"```",
		].join("\n");
		const chunks = chunkMarkdown(headingThenCode);
		const mixed = chunks.find((c) => c.text.includes("```"));
		expect(mixed).toBeDefined();
		// heading comes first → contentType is 'text', not 'code'
		expect(mixed!.contentType).toBe("text");
	});

	it("prose after the block lands in its own text chunk", () => {
		const chunks = chunkMarkdown(bigCodeBlock);
		const last = chunks[chunks.length - 1];
		expect(last.contentType).toBe("text");
		expect(last.text).toContain("Prose that follows");
	});

	it("small code blocks (under target) are also kept whole", () => {
		const small = ["Intro text. ".repeat(5), "", "```ts", "const x = 1", "```", "", "More text. ".repeat(20)].join(
			"\n",
		);
		const chunks = chunkMarkdown(small);
		const fenceCount = chunks.reduce((n, c) => n + (c.text.match(/```/g) ?? []).length, 0);
		expect(fenceCount % 2).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Nav classification — extended patterns
// ---------------------------------------------------------------------------

describe("extended nav classification", () => {
	it("classifies links inside role=navigation as nav", () => {
		const dom = new JSDOM('<html><body><div role="navigation"><a href="/x">link</a></div></body></html>');
		const a = dom.window.document.querySelector("a")!;
		expect(a.closest("[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary']")).not.toBeNull();
	});

	it("returns empty tags when no meta tags and no fallback", () => {
		const dom = new JSDOM("<html><head></head></html>");
		const tags = extractTags(dom.window.document);
		expect(tags).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// IHttpClient injection — spider() without real network
// ---------------------------------------------------------------------------

import { spider } from "../src/spider.js";
import type { IHttpClient } from "../src/ports.js";

function makeHtmlResponse(html: string, status = 200): ReturnType<IHttpClient["fetch"]> {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers: { get: () => null },
		text: () => Promise.resolve(html),
	});
}

function mockClient(html: string, status = 200): IHttpClient {
	return { fetch: () => makeHtmlResponse(html, status) };
}

const SIMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test Page</title>
  <meta name="description" content="A test description">
  <meta name="keywords" content="testing, spider">
</head>
<body>
  <article>
    <h1>Hello World</h1>
    <p>${"Content paragraph. ".repeat(30)}</p>
    <h2>Section Two</h2>
    <p>${"More content here. ".repeat(30)}</p>
  </article>
</body>
</html>`;

describe("spider() with injected IHttpClient", () => {
	it("fetches and parses a page without real network", async () => {
		const page = await spider("https://example.com", { httpClient: mockClient(SIMPLE_HTML) });
		expect(page.url).toBe("https://example.com");
		expect(page.title).toContain("Test Page");
		expect(page.description).toBe("A test description");
		expect(page.tags).toContain("testing");
		expect(page.markdown.length).toBeGreaterThan(0);
		expect(page.chunks.length).toBeGreaterThan(0);
	});

	it("returns a lean page without network", async () => {
		const page = await spider("https://example.com", {
			httpClient: mockClient(SIMPLE_HTML),
			view: "lean",
		});
		expect(page.view).toBe("lean");
		expect(page.title).toContain("Test Page");
		expect(page.headings.length).toBeGreaterThan(0);
	});

	it("throws FetchError on non-200 response", async () => {
		await expect(
			spider("https://example.com", { httpClient: mockClient("", 404) })
		).rejects.toThrow("404");
	});

	it("throws on non-http URL without touching the client", async () => {
		const client = { fetch: vi.fn() };
		await expect(spider("ftp://example.com", { httpClient: client })).rejects.toThrow("Unsupported protocol");
		expect(client.fetch).not.toHaveBeenCalled();
	});

	it("applies tokenBudget via injected client (chunk-aware)", async () => {
		const full = await spider("https://example.com", { httpClient: mockClient(SIMPLE_HTML) });
		const budgeted = await spider("https://example.com", {
			httpClient: mockClient(SIMPLE_HTML),
			tokenBudget: 50, // very small — should select fewer chunks
		});
		// Chunk-aware budget selects whole chunks up to the limit.
		// We can't guarantee fewer bytes (first chunk is always included)
		// but we must have fewer or equal chunks.
		expect(budgeted.chunks.length).toBeLessThanOrEqual(full.chunks.length);
		// Markdown is rebuilt from selected chunks only.
		if (full.chunks.length > 1) {
			expect(budgeted.chunks.length).toBeLessThan(full.chunks.length);
		}
	});
});

// ---------------------------------------------------------------------------
// WBS-TSK-2: Table-aware chunking — tables must be atomic
// ---------------------------------------------------------------------------

import { chunk } from "../src/convert.js";

describe("WBS-TSK-2: table-aware chunking", () => {
  const URL = "https://example.com/page";

  it("keeps a table in a single chunk", () => {
    const md = [
      "| Col A | Col B | Col C |",
      "| ----- | ----- | ----- |",
      "| one   | two   | three |",
      "| four  | five  | six   |",
      "| seven | eight | nine  |",
    ].join("\n");
    const chunks = chunk(md, URL);
    const tableChunks = chunks.filter((c) => c.contentType === "table");
    expect(tableChunks).toHaveLength(1);
    expect(tableChunks[0].text).toContain("| Col A");
    expect(tableChunks[0].text).toContain("| seven");
  });

  it("does not split a large table across chunk boundaries", () => {
    // Build a table with enough rows to exceed the 150-word target
    const rows = Array.from({ length: 30 }, (_, i) =>
      `| row${i} | description of row ${i} which is quite verbose | value-${i} | extra-${i} |`
    );
    const md = [
      "| Name | Description | Value | Extra |",
      "| ---- | ----------- | ----- | ----- |",
      ...rows,
    ].join("\n");
    const chunks = chunk(md, URL);
    const tableChunks = chunks.filter((c) => c.contentType === "table");
    expect(tableChunks).toHaveLength(1);
  });

  it("flushes prose before a table so they are in separate chunks", () => {
    const prose = Array.from({ length: 20 }, (_, i) =>
      `Word${i} `.repeat(8).trim()
    ).join(" ");
    const table = [
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "| 3 | 4 |",
    ].join("\n");
    const md = prose + "\n\n" + table;
    const chunks = chunk(md, URL);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const tableChunks = chunks.filter((c) => c.contentType === "table");
    const textChunks = chunks.filter((c) => c.contentType === "text");
    expect(tableChunks).toHaveLength(1);
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    // The table chunk must not contain the prose
    expect(tableChunks[0].text).not.toContain("Word0");
  });

  it("prose after a table goes into a separate chunk", () => {
    const table = [
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");
    const after = Array.from({ length: 20 }, (_, i) => `After${i} `.repeat(8).trim()).join(" ");
    const md = table + "\n\n" + after;
    const chunks = chunk(md, URL);
    const tableChunks = chunks.filter((c) => c.contentType === "table");
    expect(tableChunks).toHaveLength(1);
    expect(tableChunks[0].text).not.toContain("After0");
  });

  it("pipe characters inside code blocks are not treated as table rows", () => {
    const md = [
      "```python",
      "| fake | table | inside | code | block | row | here |",
      "| another | row | in | code |",
      "x = 1  # not a table row",
      "```",
    ].join("\n");
    const chunks = chunk(md, URL);
    // The | lines inside the code block must not produce a table chunk
    const tableChunks = chunks.filter((c) => c.contentType === "table");
    expect(tableChunks).toHaveLength(0);
    // The pipe content must still exist in the output (inside a code chunk)
    const allText = chunks.map((c) => c.text).join("\n");
    expect(allText).toContain("| fake | table");
  });
});
