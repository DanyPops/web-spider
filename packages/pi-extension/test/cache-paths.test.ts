/**
 * Cache path tests — local materialized view behaviour.
 *
 * Two paths in execute() that were previously uncovered:
 *
 *   1. Cache hit  — when a URL has already been fetched, web_fetch(url)
 *                   returns the cached page without a real second fetch.
 *   2. Cache search — web_fetch({ query }) with no url searches all cached
 *                     pages using BM25F and returns ranked hits.
 *
 * Both paths use a single harness session so the daemon's cache accumulates
 * state across calls as it would in a real Pi session. Pages are served by
 * a real local HTTP fixture server and fetched by the real (isolated) Web
 * Spider daemon — mocking globalThis.fetch in this process no longer works
 * once fetching moved into the daemon's own process.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts"
import { isolatedDaemonEnv, type IsolatedDaemonEnv } from "./daemon-isolation.js"
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, "../../web-spider/fixtures")
const ARTICLE_HTML = readFileSync(join(FIXTURES, "article-with-images.html"), "utf8")

let h: ExtensionHarness
let isolated: IsolatedDaemonEnv
let server: FixtureServer
let URL_A: string
let URL_B: string

beforeAll(async () => {
  isolated = isolatedDaemonEnv("pi-web-spider-cache-paths-test-")
  server = await startFixtureServer()
  server.set("/article-a", ARTICLE_HTML)
  server.set("/article-b", ARTICLE_HTML)
  URL_A = `${server.baseUrl}/article-a`
  URL_B = `${server.baseUrl}/article-b`

  const { default: factory } = await import("../src/index.js")
  h = createExtensionHarness(factory, { cwd: "/tmp", env: isolated.env })
  await h.boot()
})

afterAll(async () => {
  await h.shutdown()
  await server.close()
  isolated.cleanup()
})

// ---------------------------------------------------------------------------
// Cache listing — no url, no query
// ---------------------------------------------------------------------------

describe("cache listing path", () => {
  it("returns total=0 and empty pages on a cold cache", async () => {
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
    const result = await h.invokeTool("web_fetch", { url: URL_A, format: "lean" }) as { content: { text: string }[]; details: Record<string, unknown> }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)
    expect(result.details.cache).toBe("miss")
  })

  it("returns the cached page on second call without hitting the network", async () => {
    const result = await h.invokeTool("web_fetch", { url: URL_A, format: "lean" }) as { content: { text: string }[]; details: Record<string, unknown> }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)
    // The daemon's own cache reports this as a hit — the authoritative signal
    // that no second real fetch happened (replaces the old fetch-mock-call-count check).
    expect(result.details.cache).toBe("hit")
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
    const result = await h.invokeTool("web_fetch", { url: URL_B, format: "lean" }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
  })

  it("returns BM25F hits when query matches cached content", async () => {
    const result = await h.invokeTool("web_fetch", { query: "image scraping web spider" }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("hits")
    expect(Array.isArray(text.hits)).toBe(true)
    expect(text.hits.length).toBeGreaterThan(0)
    expect(text).toHaveProperty("pagesSearched")
    expect(text.pagesSearched).toBeGreaterThanOrEqual(1)
  })

  it("each hit has url, score, and text", async () => {
    const result = await h.invokeTool("web_fetch", { query: "image scraping" }) as { content: { text: string }[] }
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
    const result = await h.invokeTool("web_fetch", { grep: "article-a" }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text.pages.every((p: { url: string }) => p.url.includes("article-a"))).toBe(true)
  })
})
