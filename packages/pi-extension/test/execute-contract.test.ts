/**
 * execute() contract tests
 *
 * Pi extensions must never throw from execute() — unhandled exceptions
 * propagate to the TUI and produce noise or crashes. Every error path
 * must return { content: [{ type: "text", text: JSON.stringify({ error }) }] }.
 *
 * These tests verify the contract by provoking real failure conditions:
 * invalid URLs, unreachable hosts, and missing required parameters.
 */

import { describe, it, expect } from "vitest"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import piviFactory from "../src/index.js"

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI stub — captures the registered tool's execute function
// ---------------------------------------------------------------------------

async function bootExtension() {
  let execute: ((id: string, params: Record<string, unknown>) => Promise<unknown>) | null = null

  const stubApi = {
    registerTool(spec: { execute: typeof execute }) {
      execute = spec.execute
    },
    on: () => {},
    registerCommand: () => {},
    setActiveTools: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI

  await piviFactory(stubApi)

  if (!execute) throw new Error("web_fetch tool was not registered")
  return execute
}

// ---------------------------------------------------------------------------
// Contract: execute() never throws — all errors become { error } responses
// ---------------------------------------------------------------------------

describe("execute() error contract: never throws, always returns { error }", () => {
  it("invalid URL scheme returns error, does not throw", async () => {
    const execute = await bootExtension()
    const result = await execute("test", { url: "ftp://not-supported.example.com" })
    expect(result).toHaveProperty("content")
    const text = JSON.parse((result as any).content[0].text)
    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
  })

  it("unreachable host returns error, does not throw", async () => {
    const execute = await bootExtension()
    const result = await execute("test", {
      url: "http://this-host-does-not-exist-pivi-test.invalid",
      timeoutMs: 3000,
    })
    expect(result).toHaveProperty("content")
    const text = JSON.parse((result as any).content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("missing url and searchQuery returns error, does not throw", async () => {
    const execute = await bootExtension()
    const result = await execute("test", {})
    expect(result).toHaveProperty("content")
    const text = JSON.parse((result as any).content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("highlights format without query returns error, does not throw", async () => {
    // highlights requires a query param — missing it is a user error, not a throw
    const execute = await bootExtension()
    // We can't hit a real URL in CI, so test the validation path with a cached-miss
    // by using a non-existent local URL that resolves quickly to a connection refusal
    const result = await execute("test", {
      url: "http://127.0.0.1:1",  // connection refused — fast failure
      format: "highlights",
      // no query — should return error regardless of fetch outcome
    })
    expect(result).toHaveProperty("content")
    // Either a fetch error OR a "highlights requires query" error — both are valid { error }
    const text = JSON.parse((result as any).content[0].text)
    expect(text).toHaveProperty("error")
  })

  it("search with no API key returns content (empty results), does not throw", async () => {
    const execute = await bootExtension()
    // No BRAVE/TAVILY/EXA keys in test env — webSearch() returns empty gracefully.
    // The contract is that execute() NEVER throws; empty results are valid output.
    const env = { ...process.env }
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.TAVILY_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const result = await execute("test", { searchQuery: "test query" })
      // Must return content (not throw), even if empty results
      expect(result).toHaveProperty("content")
      expect((result as any).content[0]).toHaveProperty("text")
    } finally {
      Object.assign(process.env, env)
    }
  })
})
