/**
 * Playwright fallback path — error propagation and happy-path coverage.
 *
 * The extension has two Playwright entry points:
 *
 *   1. Auto-fallback  — triggered when spider() detects jsRendered:true and
 *                        params.enhanced is false. The extension retries with
 *                        a PlaywrightHttpClient transparently.
 *
 *   2. enhanced=true  — caller explicitly opts into the headless browser for
 *                        the first (and only) fetch attempt.
 *
 * Both paths must:
 *   - Return a well-formed page on success.
 *   - Return { error: string } when the Playwright client throws — never crash,
 *     never leak the raw exception type.
 *
 * We use vi.mock + importActual to replace only PlaywrightHttpClient while
 * keeping the real spider(), crawl(), etc. alive. The mock is a controllable
 * stub whose fetch() behaviour is set per-test via a shared ref.
 *
 * Fixture: fixtures/gh-shell.html — a GitHub-like minimal app shell.
 * Readability finds no article content → jsRendered:true.
 * The real article HTML from fixtures/article-with-images.html is returned
 * by the stub Playwright client to simulate a successful JS-rendered fetch.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  afterEach,
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
import type { HttpRequest, HttpResponse } from "@dpopsuev/web-spider"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, "../../web-spider/fixtures")

const GH_SHELL_HTML  = readFileSync(join(FIXTURES, "gh-shell.html"),          "utf8")
const ARTICLE_HTML   = readFileSync(join(FIXTURES, "article-with-images.html"), "utf8")

const MOCK_URL = "https://github.com/hyprwm/aquamarine/issues"

// ---------------------------------------------------------------------------
// Controllable Playwright stub
// ---------------------------------------------------------------------------

/**
 * Shared ref so each test can swap the Playwright behaviour without
 * reloading the module mock.
 */
let playwrightFetchImpl: (req: HttpRequest) => Promise<HttpResponse> = async () => {
  throw new Error("playwrightFetchImpl not set — call setPlaywrightBehaviour() in each test")
}

function makeOkResponse(html: string): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text:        async () => html,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

// Replace PlaywrightHttpClient with a stub whose fetch() delegates to the
// per-test ref. All other exports are real (importActual).
vi.mock("@dpopsuev/web-spider", async (importActual) => {
  const real = await importActual<typeof import("@dpopsuev/web-spider")>()
  class StubPlaywrightHttpClient {
    async fetch(req: HttpRequest): Promise<HttpResponse> {
      return playwrightFetchImpl(req)
    }
    async close() {}
  }
  return { ...real, PlaywrightHttpClient: StubPlaywrightHttpClient }
})

// ---------------------------------------------------------------------------
// Global fetch mock — returns the gh-shell for the target URL, robots + 404
// for everything else.
// ---------------------------------------------------------------------------

function installFetchMock(pageHtml = GH_SHELL_HTML) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString()
    if (url.includes("robots.txt")) return makeOkResponse("User-agent: *\nAllow: /")
    if (url.includes("sitemap"))    return makeOkResponse("") // triggers 200 → empty
    if (url.startsWith(MOCK_URL))   return makeOkResponse(pageHtml)
    return makeOkResponse("")
  }))
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let h: ExtensionHarness

beforeEach(async () => {
  const { default: factory } = await import("../src/index.js")
  // Unique path per test — prevents cache hits from a previous test's successful
  // fetch from bypassing Playwright in subsequent error-propagation tests.
  // Without isolation the first test caches the page, later tests return it
  // immediately from DiskCache.load(), and Playwright is never invoked.
  const cachePath = `/tmp/ws-playwright-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  h = createExtensionHarness(factory, {
    cwd: "/tmp",
    env: { WEB_SPIDER_CACHE_PATH: cachePath },
  })
  await h.boot()
})

afterEach(async () => {
  await h.shutdown()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Auto-fallback — jsRendered:true → retry with Playwright
// ---------------------------------------------------------------------------

describe("auto-fallback: jsRendered:true → Playwright retry", () => {
  it("returns article content when Playwright succeeds", async () => {
    installFetchMock(GH_SHELL_HTML)
    playwrightFetchImpl = async () => makeOkResponse(ARTICLE_HTML)

    const result = await h.invokeTool("web_fetch", {
      url: MOCK_URL,
      format: "lean",
    }) as { content: { text: string }[] }

    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("title")
    expect(text.title.length).toBeGreaterThan(0)
    expect(text).toHaveProperty("wordCount")
    expect(text.wordCount).toBeGreaterThan(0)
  })

  it("propagates error cleanly when Playwright throws a generic error", async () => {
    installFetchMock(GH_SHELL_HTML)
    playwrightFetchImpl = async () => { throw new Error("Browser closed unexpectedly") }

    const result = await h.invokeTool("web_fetch", { url: MOCK_URL }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
    expect(text.error).toContain("Browser closed unexpectedly")
  })

  it("propagates error cleanly when Playwright throws 'Map operation called on non-Map object'", async () => {
    installFetchMock(GH_SHELL_HTML)
    playwrightFetchImpl = async () => { throw new TypeError("Map operation called on non-Map object") }

    const result = await h.invokeTool("web_fetch", { url: MOCK_URL }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
    expect(text.error).toContain("Map operation called on non-Map object")
  })

  it("propagates error cleanly when Playwright throws a timeout", async () => {
    installFetchMock(GH_SHELL_HTML)
    playwrightFetchImpl = async () => { throw new Error("Timeout 30000ms exceeded.") }

    const result = await h.invokeTool("web_fetch", { url: MOCK_URL }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
    expect(text.error).toContain("Timeout")
  })

  it("propagates error cleanly when Playwright throws a non-Error value", async () => {
    installFetchMock(GH_SHELL_HTML)
    playwrightFetchImpl = async () => { throw "chromium launch failed" }

    const result = await h.invokeTool("web_fetch", { url: MOCK_URL }) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
  })

  it("does not call Playwright when direct fetch returns readable content", async () => {
    // ARTICLE_HTML has enough content for Readability → jsRendered stays false
    installFetchMock(ARTICLE_HTML)
    playwrightFetchImpl = async () => {
      throw new Error("Playwright should NOT have been called for a readable page")
    }

    const result = await h.invokeTool("web_fetch", {
      url: MOCK_URL,
      format: "lean",
    }) as { content: { text: string }[] }

    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// enhanced=true — Playwright is used for the first fetch, no fallback needed
// ---------------------------------------------------------------------------

describe("enhanced=true: Playwright used for initial fetch", () => {
  it("returns content when Playwright succeeds", async () => {
    installFetchMock() // fetch mock won't be called for the main page
    playwrightFetchImpl = async () => makeOkResponse(ARTICLE_HTML)

    const result = await h.invokeTool("web_fetch", {
      url: MOCK_URL,
      format: "lean",
      enhanced: true,
    }) as { content: { text: string }[] }

    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text.wordCount).toBeGreaterThan(0)
  })

  it("returns { error } when Playwright throws — does not crash", async () => {
    installFetchMock()
    playwrightFetchImpl = async () => { throw new Error("executable doesn't exist at /nonexistent") }

    const result = await h.invokeTool("web_fetch", {
      url: MOCK_URL,
      enhanced: true,
    }) as { content: { text: string }[] }

    const text = JSON.parse(result.content[0].text)
    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
  })
})
