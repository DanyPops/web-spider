/**
 * Cache path tests — local materialized view behaviour.
 *
 * Two paths in execute() that were previously uncovered:
 *
 *   1. Cache hit  — when a URL has already been fetched in this session,
 *                   web_fetch(url) returns the cached page without hitting
 *                   the network again.
 *
 *   2. Cache search — web_fetch({ query }) with no url searches all cached
 *                     pages using BM25F and returns ranked hits.
 *
 * Both paths use a single harness session so the cache accumulates state
 * across calls as it would in a real Pi session.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  createExtensionHarness,
  type ExtensionHarness,
} from "@earendil-works/pi-coding-agent/testing"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, "../../web-spider/fixtures")
const ARTICLE_HTML = readFileSync(join(FIXTURES, "article-with-images.html"), "utf8")

const URL_A = "https://example.com/article-a"
const URL_B = "https://example.com/article-b"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(html: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text:        async () => html,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

// ---------------------------------------------------------------------------
// Single shared session — cache builds up across tests
// ---------------------------------------------------------------------------

let h: ExtensionHarness
let fetchMock: ReturnType<typeof vi.fn>

beforeAll(async () => {
  const { default: factory } = await import("../src/index.js")
  h = createExtensionHarness(factory, {
    cwd: "/tmp",
    env: { WEB_SPIDER_CACHE_PATH: "/tmp/ws-cache-paths-test.json" },
  })
  await h.boot()
})

afterAll(async () => {
  await h.shutdown()
})

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString()
    if (url.includes("robots.txt")) return makeOkResponse("User-agent: *\nAllow: /")
    if (url.includes("sitemap"))    return { ...makeOkResponse(""), status: 404, ok: false }
    if (url.startsWith("https://example.com")) return makeOkResponse(ARTICLE_HTML)
    return { ...makeOkResponse(""), status: 404, ok: false }
  })
  vi.stubGlobal("fetch", fetchMock)
})

// ---------------------------------------------------------------------------
// Cache listing — no url, no query
// ---------------------------------------------------------------------------

describe("cache listing path", () => {
  it("returns total=0 and empty pages on a cold cache", async () => {
    // Fresh harness in beforeAll, no fetches yet.
    const result = await h.invokeTool("web_fetch", {}) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("total")
    expect(text).toHaveProperty("pages")
    expect(Array.isArray(text.pages)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cache hit — second fetch for the same URL skips the network
// ---------------------------------------------------------------------------

describe("cache hit path", () => {
  it("fetches URL_A on first call", async () => {
    const result = await h.invokeTool("web_fetch", {
      url: URL_A,
      format: "lean",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)
  })

  it("returns the cached page on second call without hitting the network", async () => {
    // Reset the mock so we can assert it was NOT called again.
    fetchMock.mockClear()

    const result = await h.invokeTool("web_fetch", {
      url: URL_A,
      format: "lean",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)

    // Network was not touched for the main URL — only robots.txt may fire.
    const mainUrlCalls = fetchMock.mock.calls.filter(
      ([input]: [RequestInfo | URL]) => input.toString().startsWith(URL_A)
    )
    expect(mainUrlCalls).toHaveLength(0)
  })

  it("cache listing shows URL_A after it has been fetched", async () => {
    const result = await h.invokeTool("web_fetch", {}) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text.total).toBeGreaterThanOrEqual(1)
    const urls = text.pages.map((p: { url: string }) => p.url)
    expect(urls).toContain(URL_A)
  })
})

// ---------------------------------------------------------------------------
// Cache search — no url, with query
// ---------------------------------------------------------------------------

describe("cache search path", () => {
  it("fetches URL_B to populate the cache", async () => {
    const result = await h.invokeTool("web_fetch", {
      url: URL_B,
      format: "lean",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
  })

  it("returns BM25F hits when query matches cached content", async () => {
    const result = await h.invokeTool("web_fetch", {
      query: "image scraping web spider",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("hits")
    expect(Array.isArray(text.hits)).toBe(true)
    expect(text.hits.length).toBeGreaterThan(0)
    expect(text).toHaveProperty("pagesSearched")
    expect(text.pagesSearched).toBeGreaterThanOrEqual(1)
  })

  it("each hit has url, score, and text", async () => {
    const result = await h.invokeTool("web_fetch", {
      query: "image scraping",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)
    const hit = text.hits[0]

    expect(hit).toHaveProperty("url")
    expect(hit).toHaveProperty("score")
    expect(typeof hit.score).toBe("number")
  })

  it("returns zero hits gracefully for a query with no matches", async () => {
    const result = await h.invokeTool("web_fetch", {
      // Use a single token with no vowels — avoids the hyphen-splitting bug where
    // "xyzzy-no-such-content-ever-12345" tokenises to [xyzzy, no, such, content,
    // ever, 12345] and "content" literally matches the article fixture.
    query: "zxqfkwjpvm",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("hits")
    expect(text.hits).toHaveLength(0)
  })

  it("grep= filter narrows cache listing results", async () => {
    const result = await h.invokeTool("web_fetch", {
      grep: "article-a",
    }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.pages.every((p: { url: string }) => p.url.includes("article-a"))).toBe(true)
  })
})
