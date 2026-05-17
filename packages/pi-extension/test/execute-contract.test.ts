/**
 * execute() contract tests.
 *
 * Pi extensions must never throw from execute() — unhandled exceptions
 * propagate to the TUI and produce noise or crashes. Every error path
 * must return { content: [{ type: "text", text: JSON.stringify({ error }) }] }.
 *
 * Uses createExtensionHarness from @earendil-works/pi-coding-agent/testing
 * so the boot setup is one line rather than a hand-rolled stub.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createExtensionHarness, type ExtensionHarness } from "@earendil-works/pi-coding-agent/testing"
import piFactory from "../src/index.js"

let h: ExtensionHarness

beforeAll(async () => {
  h = createExtensionHarness(piFactory, { cwd: "/tmp" })
  await h.boot()
})

afterAll(async () => {
  await h.shutdown()
})

describe("execute() error contract: never throws, always returns content", () => {
  it("invalid URL scheme returns error, does not throw", async () => {
    const result = await h.invokeTool("web_fetch", { url: "ftp://not-supported.example.com" }) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
  })

  it("unreachable host returns error, does not throw", async () => {
    const result = await h.invokeTool("web_fetch", {
      url: "http://this-host-does-not-exist-pivi-test.invalid",
      timeoutMs: 3000,
    }) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("missing url and searchQuery returns error, does not throw", async () => {
    const result = await h.invokeTool("web_fetch", {}) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("highlights without query returns error, does not throw", async () => {
    const result = await h.invokeTool("web_fetch", {
      url: "http://127.0.0.1:1",
      format: "highlights",
    }) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("search with no API key returns content, does not throw", async () => {
    const env = { ...process.env }
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const result = await h.invokeTool("web_fetch", { searchQuery: "test query" }) as any
      expect(result).toHaveProperty("content")
      expect(result.content[0]).toHaveProperty("text")
    } finally {
      Object.assign(process.env, env)
    }
  })
})
