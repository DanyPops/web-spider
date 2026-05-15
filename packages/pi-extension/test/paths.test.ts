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

/** Load a fresh extension instance and return its execute() function. */
async function loadExecute(): Promise<ExecuteFn> {
  const { createJiti: cj } = await import(jitiPath)
  const jiti = cj(JITI_BASE, { moduleCache: false, tryNative: false })
  const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void>

  let capturedExecute: ExecuteFn | null = null
  const api = {
    registerTool: vi.fn((tool: { name: string; execute: ExecuteFn }) => {
      capturedExecute = tool.execute
    }),
    on: vi.fn(), registerCommand: vi.fn(), registerShortcut: vi.fn(),
    registerFlag: vi.fn(), appendEntry: vi.fn(),
  }

  // Use a temp path so disk-cache tests don't pollute the real cache
  process.env["WEB_SPIDER_CACHE_PATH"] = "/tmp/web-spider-test-cache.json"
  await factory(api)
  delete process.env["WEB_SPIDER_CACHE_PATH"]

  if (!capturedExecute) throw new Error("execute() was not captured — registerTool not called")
  return capturedExecute
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
// Search path
// ---------------------------------------------------------------------------

describe("search path", () => {
  let execute: ExecuteFn
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    execute = await loadExecute()
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock())
  })
  afterEach(() => {
    fetchSpy.mockRestore()
    delete process.env["BRAVE_SEARCH_API_KEY"]
  })

  it("returns error when no search key is configured", async () => {
    const result = await execute("1", { searchQuery: "test query" })
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
  })

  it("returns results when BRAVE_SEARCH_API_KEY is set", async () => {
    process.env["BRAVE_SEARCH_API_KEY"] = "test-key"
    const result = await execute("1", { searchQuery: "web scraping" })
    const body = JSON.parse(result.content[0].text)
    expect(body.query).toBe("web scraping")
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
  })

  it("returns error when neither url nor searchQuery provided", async () => {
    const result = await execute("1", {})
    const body = JSON.parse(result.content[0].text)
    expect(body.error).toBeDefined()
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
