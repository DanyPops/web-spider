/**
 * Extension path tests — ablation coverage for each execute() branch.
 *
 * Tests the search, crawl, and single-page paths by:
 *   1. Loading the extension via jiti (same mode as pi loads it)
 *   2. Capturing the registered execute() function
 *   3. Mocking globalThis.fetch to serve fixture HTML without network access
 *
 * Each describe block loads a fresh extension factory to avoid session-state
 * leakage between suites (cache, graph, corpus are per-factory).
 */

import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(__dirname, "../src/index.ts")

const require = createRequire(import.meta.url)
const jitiPath = require.resolve("jiti")
const JITI_BASE = `file://${join(__dirname, "../src/index.ts")}`

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_URL = "https://test.example.com/article"

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
    <a href="https://example.com/related">Related article</a>
    <a href="https://example.com/other">Another link</a>
  </article>
</body>
</html>`

const BRAVE_RESPONSE = JSON.stringify({
  web: {
    results: [
      { url: "https://example.com/a", title: "Result A", description: "Snippet A" },
      { url: "https://example.com/b", title: "Result B", description: "Snippet B" },
    ],
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecuteFn = (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>

function mockResponse(body: string, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
}

/** Mock fetch that handles all the URLs spider/crawl may contact. */
function makeFetchMock(pageHtml = FIXTURE_HTML) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString()
    if (url.includes("robots.txt"))    return mockResponse("User-agent: *\nAllow: /")
    if (url.includes("sitemap"))       return mockResponse("", 404)
    if (url.includes("brave.com"))     return mockResponse(BRAVE_RESPONSE)
    if (url.startsWith(MOCK_URL))      return mockResponse(pageHtml)
    return mockResponse("", 404)
  })
}

/** Load a fresh extension and return the execute() for a specific tool name. */
async function loadExecute(toolName = "web_fetch"): Promise<ExecuteFn> {
  const { createJiti: cj } = await import(jitiPath)
  const jiti = cj(JITI_BASE, { moduleCache: false, tryNative: false })
  const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void>

  const tools = new Map<string, ExecuteFn>()
  const api = {
    registerTool: vi.fn((tool: { name: string; execute: ExecuteFn }) => {
      tools.set(tool.name, tool.execute)
    }),
    on: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(),
    registerFlag: vi.fn(), appendEntry: vi.fn(),
  }

  process.env["WEB_SPIDER_CACHE_PATH"] = "/tmp/web-spider-test-cache.json"
  await factory(api)
  delete process.env["WEB_SPIDER_CACHE_PATH"]

  const fn = tools.get(toolName)
  if (!fn) throw new Error(`Tool '${toolName}' not registered — got: ${[...tools.keys()].join(", ")}`)
  return fn
}

// ---------------------------------------------------------------------------
// Single-page path — format=markdown (default)
// ---------------------------------------------------------------------------

describe("single-page path — markdown", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns url, title, wordCount, markdown fields", async () => {
    const result = await execute("1", { url: MOCK_URL })
    const body = JSON.parse(result.content[0].text)
    expect(body.url).toBe(MOCK_URL)
    expect(typeof body.title).toBe("string")
    expect(body.title.length).toBeGreaterThan(0)
    expect(typeof body.markdown).toBe("string")
    expect(body.markdown.length).toBeGreaterThan(0)
    expect(typeof body.wordCount).toBe("number")
  })

  it("details includes format and wordCount", async () => {
    const result = await execute("1", { url: MOCK_URL })
    expect(result.details.format).toBe("markdown")
    expect(typeof result.details.wordCount).toBe("number")
  })

  it("does not include chunks or links in output", async () => {
    const result = await execute("1", { url: MOCK_URL })
    const body = JSON.parse(result.content[0].text)
    expect(body.chunks).toBeUndefined()
    expect(body.links).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Single-page path — format=lean
// ---------------------------------------------------------------------------

describe("single-page path — lean", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns url, title, headings, bodyLinks — no markdown", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "lean" })
    const body = JSON.parse(result.content[0].text)
    expect(body.url).toBe(MOCK_URL)
    expect(Array.isArray(body.headings)).toBe(true)
    expect(body.headings.length).toBeGreaterThan(0)
    expect(body.markdown).toBeUndefined()
  })

  it("headings are flat markdown strings", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "lean" })
    const body = JSON.parse(result.content[0].text)
    for (const h of body.headings) {
      expect(h).toMatch(/^#{1,6} /)
    }
  })

  it("details includes format=lean", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "lean" })
    expect(result.details.format).toBe("lean")
  })
})

// ---------------------------------------------------------------------------
// Single-page path — format=links
// ---------------------------------------------------------------------------

describe("single-page path — links", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns url, title, bodyLinks — no markdown", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "links" })
    const body = JSON.parse(result.content[0].text)
    expect(body.url).toBe(MOCK_URL)
    expect(Array.isArray(body.bodyLinks)).toBe(true)
    expect(body.markdown).toBeUndefined()
  })

  it("bodyLinks have href and text", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "links" })
    const body = JSON.parse(result.content[0].text)
    for (const l of body.bodyLinks) {
      expect(typeof l.href).toBe("string")
      expect(typeof l.text).toBe("string")
    }
  })
})

// ---------------------------------------------------------------------------
// Single-page path — format=highlights
// ---------------------------------------------------------------------------

describe("single-page path — highlights", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns error when query is missing", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "highlights" })
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
  })

  it("returns hits array when query is provided", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "highlights", query: "cost optimization" })
    const body = JSON.parse(result.content[0].text)
    expect(body.url).toBe(MOCK_URL)
    expect(Array.isArray(body.hits)).toBe(true)
  })

  it("details includes format=highlights and hit count", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "highlights", query: "spider" })
    expect(result.details.format).toBe("highlights")
    expect(typeof result.details.hits).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// Crawl path (depth > 0)
// ---------------------------------------------------------------------------

describe("crawl path — depth=1", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns pagesFound and pages array", async () => {
    const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 3 })
    const body = JSON.parse(result.content[0].text)
    expect(typeof body.pagesFound).toBe("number")
    expect(body.pagesFound).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(body.pages)).toBe(true)
  })

  it("details includes depth and pagesFound", async () => {
    const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 2 })
    expect(result.details.depth).toBe(1)
    expect(typeof result.details.pagesFound).toBe("number")
  })

  it("format=lean returns leanOutput per page", async () => {
    const result = await execute("1", { url: MOCK_URL, depth: 1, maxPages: 2, format: "lean" })
    const body = JSON.parse(result.content[0].text)
    expect(Array.isArray(body.pages)).toBe(true)
    // Each page in lean crawl has headings and url
    for (const page of body.pages) {
      expect(typeof page.url).toBe("string")
      expect(typeof page.wordCount).toBe("number")
    }
  })

  it("highlights format without query returns error", async () => {
    const result = await execute("1", { url: MOCK_URL, depth: 1, format: "highlights" })
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
  })

  it("highlights format with query returns hits", async () => {
    const result = await execute("1", { url: MOCK_URL, depth: 1, format: "highlights", query: "spider fixture" })
    const body = JSON.parse(result.content[0].text)
    expect(Array.isArray(body.hits)).toBe(true)
    expect(typeof body.pagesSearched).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// format=tree paths — full tree, query, navigate — all via web_fetch
// ---------------------------------------------------------------------------

describe("single-page path — tree (full)", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute("web_fetch")
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns a tree with tag=article at root", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree" })
    const tree = JSON.parse(result.content[0].text)
    expect(tree.tag).toBe("article")
    expect(tree.path).toBe("article")
  })

  it("tree has children", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree" })
    const tree = JSON.parse(result.content[0].text)
    expect(Array.isArray(tree.children)).toBe(true)
    expect(tree.children.length).toBeGreaterThan(0)
  })

  it("details includes format=tree mode=full", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree" })
    expect(result.details.format).toBe("tree")
    expect(result.details.mode).toBe("full")
  })

  it("returns error for network failure", async () => {
    fetchSpy.mockImplementation(async () => { throw new Error("ECONNREFUSED") })
    const result = await execute("1", { url: MOCK_URL, format: "tree" })
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
  })
})

describe("single-page path — tree + query", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute("web_fetch")
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns hits array with url and query", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", query: "spider fixture" })
    const body = JSON.parse(result.content[0].text)
    expect(Array.isArray(body.hits)).toBe(true)
    expect(body.url).toBe(MOCK_URL)
    expect(body.query).toBe("spider fixture")
  })

  it("each hit has path, tag, score, snippet", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", query: "section" })
    const body = JSON.parse(result.content[0].text)
    for (const hit of body.hits) {
      expect(typeof hit.path).toBe("string")
      expect(typeof hit.tag).toBe("string")
      expect(typeof hit.score).toBe("number")
      expect(typeof hit.snippet).toBe("string")
    }
  })

  it("respects topN", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", query: "the", topN: 2 })
    const body = JSON.parse(result.content[0].text)
    expect(body.hits.length).toBeLessThanOrEqual(2)
  })

  it("details includes mode=query and hit count", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", query: "spider" })
    expect(result.details.mode).toBe("query")
    expect(typeof result.details.hits).toBe("number")
  })
})

describe("single-page path — tree + path (navigate)", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute("web_fetch")
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => fetchSpy.mockRestore())

  it("returns error for unknown path", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article.nonexistent[99]" })
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
  })

  it("returns article root node for path=article", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article" })
    const body = JSON.parse(result.content[0].text)
    expect(body.tag).toBe("article")
    expect(body.path).toBe("article")
  })

  it("details includes mode=navigate, tag, path", async () => {
    const result = await execute("1", { url: MOCK_URL, format: "tree", path: "article" })
    expect(result.details.mode).toBe("navigate")
    expect(result.details.tag).toBe("article")
    expect(result.details.path).toBe("article")
  })
})
