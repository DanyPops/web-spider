/**
 * Extension path tests — ablation coverage for each execute() branch.
 *
 * Tests the crawl and single-page paths against a real, isolated Web Spider
 * daemon (auto-started by the extension itself, see daemon-isolation.ts)
 * fetching a real local fixture HTTP server — not a mocked globalThis.fetch.
 * That approach stopped working once fetching moved into the daemon's own
 * (separate) process, which never sees this process's mocked fetch.
 *
 * Each describe block loads a fresh extension factory (fresh in-memory tool
 * registration) but all share one isolated daemon + fixture server for the
 * file, matching the previous behavior of one shared on-disk cache file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import piFactory from "../src/index.js";
import { type IsolatedDaemonEnv, isolatedDaemonEnv } from "./daemon-isolation.js";
import { createExtensionHarness } from "./harness/index.ts";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Spider Test Page</title>
  <meta name="description" content="A fixture page for path tests">
</head>
<body>
  <article>
    <h1>Spider Test Article</h1>
    <h2>Section One</h2>
    <p>This fixture page is used to test the web spider extension paths.
       It contains enough prose for Readability to extract meaningful content,
       including headings, links, and multiple paragraphs of body text.</p>
    <h2>Section Two</h2>
    <p>The cost optimization strategies described here are illustrative.
       OpenAI API calls can be expensive; caching and chunking help.</p>
    <a href="/related">Related article</a>
    <a href="/other">Another link</a>
  </article>
</body>
</html>`;

let isolated: IsolatedDaemonEnv;
let server: FixtureServer;
let MOCK_URL: string;

beforeAll(async () => {
	isolated = isolatedDaemonEnv("pi-web-spider-paths-test-");
	server = await startFixtureServer();
	server.set("/article", FIXTURE_HTML);
	server.set(
		"/related",
		"<html><body><article><h1>Related</h1><p>Related page body text, long enough for Readability to extract as an article rather than treating it as empty content.</p></article></body></html>",
	);
	server.set(
		"/other",
		"<html><body><article><h1>Other</h1><p>Other page body text, also long enough for Readability to extract as an article rather than treating it as empty content.</p></article></body></html>",
	);
	MOCK_URL = `${server.baseUrl}/article`;
});

afterAll(async () => {
	await server.close();
	isolated.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecuteFn = (
	id: string,
	params: Record<string, unknown>,
) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;

/**
 * Load a fresh extension (via the real ExtensionHarness, not a hand-rolled
 * registerTool stub) and return an execute()-shaped wrapper around
 * h.invokeTool() for a specific tool name.
 *
 * Every operation this extension calls now goes through Vehicle (task
 * 4057390d), which needs a real ExtensionContext (specifically
 * context.sessionManager) to build a correlationId -- a hand-rolled stub
 * `api` object with no real `ctx` can no longer stand in here. The harness
 * supplies one; `id` is accepted for this file's own call-site compatibility
 * but not otherwise used (invokeTool supplies its own fixed toolCallId).
 */
async function loadExecute(toolName = "web_fetch"): Promise<ExecuteFn> {
	const h = createExtensionHarness(piFactory, { cwd: "/tmp", env: isolated.env });
	await h.boot();
	return (async (_id, params) => (await h.invokeTool(toolName, params)) as Awaited<ReturnType<ExecuteFn>>) satisfies ExecuteFn;
}

// ---------------------------------------------------------------------------
// Single-page path — format=markdown (default)
// ---------------------------------------------------------------------------

describe("single-page path — markdown", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute();
	});

	it("returns url, title, wordCount, markdown fields", async () => {
		const result = await execute("1", { url: MOCK_URL });
		const body = JSON.parse(result.content[0].text);
		expect(body.url).toBe(MOCK_URL);
		expect(typeof body.title).toBe("string");
		expect(body.title.length).toBeGreaterThan(0);
		expect(typeof body.markdown).toBe("string");
		expect(body.markdown.length).toBeGreaterThan(0);
		expect(typeof body.wordCount).toBe("number");
	});

	it("details includes format and wordCount", async () => {
		const result = await execute("1", { url: MOCK_URL });
		expect(result.details.format).toBe("markdown");
		expect(typeof result.details.wordCount).toBe("number");
	});

	it("does not include chunks or links in output", async () => {
		const result = await execute("1", { url: MOCK_URL });
		const body = JSON.parse(result.content[0].text);
		expect(body.chunks).toBeUndefined();
		expect(body.links).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Single-page path — format=lean
// ---------------------------------------------------------------------------

describe("single-page path — lean", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute();
	});

	it("returns url, title, headings, bodyLinks — no markdown", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "lean" });
		const body = JSON.parse(result.content[0].text);
		expect(body.url).toBe(MOCK_URL);
		expect(Array.isArray(body.headings)).toBe(true);
		expect(body.headings.length).toBeGreaterThan(0);
		expect(body.markdown).toBeUndefined();
	});

	it("headings are flat markdown strings", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "lean" });
		const body = JSON.parse(result.content[0].text);
		for (const h of body.headings) {
			expect(h).toMatch(/^#{1,6} /);
		}
	});

	it("details includes format=lean", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "lean" });
		expect(result.details.format).toBe("lean");
	});
});

// ---------------------------------------------------------------------------
// Single-page path — format=links
// ---------------------------------------------------------------------------

describe("single-page path — links", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute();
	});

	it("returns url, title, bodyLinks — no markdown", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "links" });
		const body = JSON.parse(result.content[0].text);
		expect(body.url).toBe(MOCK_URL);
		expect(Array.isArray(body.bodyLinks)).toBe(true);
		expect(body.markdown).toBeUndefined();
	});

	it("bodyLinks have href and text", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "links" });
		const body = JSON.parse(result.content[0].text);
		for (const l of body.bodyLinks) {
			expect(typeof l.href).toBe("string");
			expect(typeof l.text).toBe("string");
		}
	});
});

// ---------------------------------------------------------------------------
// Single-page path — format=highlights
// ---------------------------------------------------------------------------

describe("single-page path — highlights", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute();
	});

	it("throws when query is missing", async () => {
		await expect(execute("1", { url: MOCK_URL, format: "highlights" })).rejects.toThrow("highlights format requires a query");
	});

	it("returns hits array when query is provided", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "highlights", query: "cost optimization" });
		const body = JSON.parse(result.content[0].text);
		expect(body.url).toBe(MOCK_URL);
		expect(Array.isArray(body.hits)).toBe(true);
	});

	it("details includes format=highlights and hit count", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "highlights", query: "spider" });
		expect(result.details.format).toBe("highlights");
		expect(typeof result.details.hits).toBe("number");
	});
});

// ---------------------------------------------------------------------------
// Crawl path (depth > 0)
// ---------------------------------------------------------------------------

describe("crawl path — depth=1", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute();
	});

	it("returns pagesFound and pages array", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 3 });
		const body = JSON.parse(result.content[0].text);
		expect(typeof body.pagesFound).toBe("number");
		expect(body.pagesFound).toBeGreaterThanOrEqual(1);
		expect(Array.isArray(body.pages)).toBe(true);
	});

	it("details includes the crawl depth and bounded page count", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 2 });
		expect(result.details).toMatchObject({ kind: "web", operation: "crawl", depth: 1 });
		expect(typeof result.details.pages).toBe("number");
	});

	it("format=lean returns leanOutput per page", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 2, format: "lean" });
		const body = JSON.parse(result.content[0].text);
		expect(Array.isArray(body.pages)).toBe(true);
		for (const page of body.pages) {
			expect(typeof page.url).toBe("string");
			expect(typeof page.wordCount).toBe("number");
		}
	});

	it("highlights format without query throws", async () => {
		await expect(execute("1", { url: MOCK_URL, depth: 1, format: "highlights" })).rejects.toThrow("highlights format requires a query");
	});

	it("highlights format with query returns hits", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, format: "highlights", query: "spider fixture" });
		const body = JSON.parse(result.content[0].text);
		expect(Array.isArray(body.hits)).toBe(true);
		expect(typeof body.pagesSearched).toBe("number");
	});

	it("each page reports a pageType and contentOk, and the result reports nextAction", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 3, format: "lean" });
		const body = JSON.parse(result.content[0].text);
		expect(typeof body.nextAction).toBe("string");
		for (const page of body.pages) {
			expect(typeof page.pageType).toBe("string");
			expect(typeof page.contentOk).toBe("boolean");
		}
	});

	it("discoverOnly:true returns page metadata with no markdown body", async () => {
		const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 3, format: "lean", discoverOnly: true });
		const body = JSON.parse(result.content[0].text);
		expect(body.pages.length).toBeGreaterThan(0);
		for (const page of body.pages) {
			expect(page).not.toHaveProperty("markdown");
		}
	});

	it("crawlUrls selectively (re-)crawls exactly those URLs, routing to crawl even without depth", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "lean", crawlUrls: [`${server.baseUrl}/related`] });
		const body = JSON.parse(result.content[0].text);
		const urls = body.pages.map((p: { url: string }) => p.url);
		expect(urls).toEqual([`${server.baseUrl}/related`]);
	});
});

// ---------------------------------------------------------------------------
// format=tree paths — full tree, query, navigate — all via web_fetch
// ---------------------------------------------------------------------------

describe("single-page path — tree (full)", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute("web_fetch");
	});

	it("returns a tree with tag=article at root", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree" });
		const tree = JSON.parse(result.content[0].text);
		expect(tree.tag).toBe("article");
		expect(tree.path).toBe("article");
	});

	it("tree has children", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree" });
		const tree = JSON.parse(result.content[0].text);
		expect(Array.isArray(tree.children)).toBe(true);
		expect(tree.children.length).toBeGreaterThan(0);
	});

	it("details identifies a full tree result", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree" });
		expect(result.details).toMatchObject({ kind: "web", format: "tree", operation: "tree-full" });
	});

	it("throws for a genuinely unreachable host", async () => {
		await expect(execute("1", { url: "http://127.0.0.1:1", format: "tree", timeoutMs: 2000 })).rejects.toThrow("tree fetch failed");
	});
});

describe("single-page path — tree + query", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute("web_fetch");
	});

	it("returns hits array with url and query", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", query: "spider fixture" });
		const body = JSON.parse(result.content[0].text);
		expect(Array.isArray(body.hits)).toBe(true);
		expect(body.url).toBe(MOCK_URL);
		expect(body.query).toBe("spider fixture");
	});

	it("each hit has path, tag, score, snippet", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", query: "section" });
		const body = JSON.parse(result.content[0].text);
		for (const hit of body.hits) {
			expect(typeof hit.path).toBe("string");
			expect(typeof hit.tag).toBe("string");
			expect(typeof hit.score).toBe("number");
			expect(typeof hit.snippet).toBe("string");
		}
	});

	it("respects topN", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", query: "the", topN: 2 });
		const body = JSON.parse(result.content[0].text);
		expect(body.hits.length).toBeLessThanOrEqual(2);
	});

	it("details identifies a tree query and hit count", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", query: "spider" });
		expect(result.details.operation).toBe("tree-query");
		expect(typeof result.details.hits).toBe("number");
	});
});

describe("single-page path — tree + path (navigate)", () => {
	let execute: ExecuteFn;

	beforeEach(async () => {
		Object.assign(process.env, isolated.env);
		execute = await loadExecute("web_fetch");
	});

	it("returns an empty typed result for unknown path", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article.nonexistent[99]" });
		expect(JSON.parse(result.content[0].text)).toMatchObject({ found: false });
		expect(result.details.status).toBe("empty");
	});

	it("returns article root node for path=article", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article" });
		const body = JSON.parse(result.content[0].text);
		expect(body.tag).toBe("article");
		expect(body.path).toBe("article");
	});

	it("details identifies tree path navigation", async () => {
		const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article" });
		expect(result.details).toMatchObject({ operation: "tree-path", path: "article" });
	});
});
