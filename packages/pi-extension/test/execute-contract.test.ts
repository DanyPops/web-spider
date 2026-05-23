/**
 * execute() contract: never throw, always return content.
 * Unhandled exceptions propagate to the Pi TUI and crash the session.
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

describe("stream hygiene: extension must not write to stdout or stderr", () => {
  it("boot produces no stdout/stderr leaks", () => {
    expect(h.leaks).toHaveLength(0)
  })
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

  it("missing url returns cache listing (not error), does not throw", async () => {
    // No url → local materialized view path: returns cache listing, not an error.
    // This is intentional: omitting url is the way to query the session cache.
    const result = await h.invokeTool("web_fetch", {}) as any
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("total")
    expect(typeof text.total).toBe("number")
    expect(text).toHaveProperty("pages")
    expect(Array.isArray(text.pages)).toBe(true)
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

})
