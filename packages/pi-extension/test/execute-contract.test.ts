import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts"
import piFactory from "../src/index.js"

let h: ExtensionHarness

beforeAll(async () => {
  h = createExtensionHarness(piFactory, { cwd: "/tmp" })
  await h.boot()
})

afterAll(async () => {
  await h.shutdown()
})

describe("stream hygiene: extension must not write to stdout or stderr", () => {
  it("boot produces no stdout/stderr leaks", () => {
    expect(h.leaks).toHaveLength(0)
  })
})

describe("execute() result and failure channels", () => {
  it("registers native call and result renderers", () => {
    const definition = h.tools.get("web_fetch")?.definition
    expect(definition).toBeDefined()
    expect(typeof definition?.renderCall).toBe("function")
    expect(typeof definition?.renderResult).toBe("function")
  })

  it("throws invalid URL failures through Pi's native error channel", async () => {
    await expect(h.invokeTool("web_fetch", { url: "ftp://not-supported.example.com" }))
      .rejects.toThrow("Unsupported protocol")
  })

  it("throws unreachable-host failures through Pi's native error channel", async () => {
    await expect(h.invokeTool("web_fetch", {
      url: "http://this-host-does-not-exist-pivi-test.invalid",
      timeoutMs: 3000,
    })).rejects.toThrow("web_fetch failed")
  })

  it("missing url returns a typed cache listing", async () => {
    const result = await h.invokeTool("web_fetch", {}) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("total")
    expect(Array.isArray(text.pages)).toBe(true)
    expect(result.details).toMatchObject({ kind: "web", operation: "cache-list", cache: "listing" })
  })

  it("validates highlights query before attempting a fetch", async () => {
    await expect(h.invokeTool("web_fetch", {
      url: "http://127.0.0.1:1",
      format: "highlights",
    })).rejects.toThrow("highlights format requires a query")
  })

  it("returns robots denial as a typed blocked outcome", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private", { status: 200 })
      throw new Error("page fetch should be blocked by robots.txt")
    }
    try {
      const result = await h.invokeTool("web_fetch", { url: "https://robots-contract.test/private" }) as any
      expect(JSON.parse(result.content[0].text)).toMatchObject({ blocked: true, reason: "robots.txt" })
      expect(result.details).toMatchObject({ kind: "web", status: "blocked", blockedBy: "robots.txt" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
