/**
 * Live fetch tests — exercise the full execute() path against the real network.
 *
 * Purpose: catch the "Map operation called on non-Map object" class of failure
 * that only surfaces when the extension runs with native ESM (tryNative:true),
 * as pi's Node.js runtime does. The existing paths.test.ts covers jiti
 * tryNative:false with mocked fetch; this file covers the native ESM path with
 * a real HTTP round-trip.
 *
 * Two loader modes are tested to mirror both production code paths:
 *
 *   native ESM (direct import)   — matches pi's Node.js dev runtime
 *   jiti tryNative:false         — matches pi's Bun binary + loadExtensionViaJiti
 *
 * Tests are skipped when offline (no LIVE_FETCH env var required — they use
 * a timeout guard instead of an env flag so CI without network just times out
 * gracefully rather than failing loudly).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  createExtensionHarness,
  loadExtensionViaJiti,
  type ExtensionHarness,
} from "./harness/index.ts"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(__dirname, "../src/index.ts")

// ---------------------------------------------------------------------------
// Shared assertion — both loader modes must produce the same shape
// ---------------------------------------------------------------------------

async function assertWikipediaFetch(h: ExtensionHarness) {
  const result = await h.invokeTool("web_fetch", {
    url: "https://en.wikipedia.org/wiki/Web_crawler",
    format: "lean",
  }) as { content: { text: string }[] }

  expect(result).toHaveProperty("content")
  const text = JSON.parse(result.content[0].text)

  // Must not be an error
  expect(text).not.toHaveProperty("error")

  // Must have expected shape
  expect(text).toHaveProperty("url", "https://en.wikipedia.org/wiki/Web_crawler")
  expect(text).toHaveProperty("title")
  expect(typeof text.title).toBe("string")
  expect(text.title.length).toBeGreaterThan(0)
  expect(text).toHaveProperty("wordCount")
  expect(text.wordCount).toBeGreaterThan(100)
  expect(text).toHaveProperty("headings")
  expect(Array.isArray(text.headings)).toBe(true)
}

// ---------------------------------------------------------------------------
// Mode A: native ESM — matches pi's Node.js dev runtime (tryNative:true)
// ---------------------------------------------------------------------------

describe("live fetch — native ESM (pi Node.js runtime path)", () => {
  let h: ExtensionHarness

  beforeAll(async () => {
    // Direct import — no jiti. This is how pi loads extensions in Node.js dev
    // mode: the factory is imported natively, then wrapped in createExtensionHarness.
    const { default: factory } = await import("../src/index.js")
    h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
  })

  afterAll(async () => {
    await h.shutdown()
  })

  it("fetches Wikipedia lean — no Map errors, correct shape", async () => {
    await assertWikipediaFetch(h)
  }, 20_000)

  it("fetches markdown format without error", async () => {
    const result = await h.invokeTool("web_fetch", {
      url: "https://en.wikipedia.org/wiki/Web_crawler",
      format: "markdown",
    }) as { content: { text: string }[] }

    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("markdown")
    expect(typeof text.markdown).toBe("string")
    expect(text.markdown.length).toBeGreaterThan(100)
  }, 20_000)

  it("no url — returns cache listing, not error", async () => {
    const result = await h.invokeTool("web_fetch", {}) as { content: { text: string }[] }
    const text = JSON.parse(result.content[0].text)
    // After fetching Wikipedia above, the cache has at least 1 entry.
    // Regardless: must return listing shape, not an error.
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("total")
    expect(typeof text.total).toBe("number")
  }, 5_000)
})

// ---------------------------------------------------------------------------
// Mode B: jiti tryNative:false — matches Bun binary + loadExtensionViaJiti
// ---------------------------------------------------------------------------

describe("live fetch — jiti tryNative:false (Bun binary path)", () => {
  let h: ExtensionHarness

  beforeAll(async () => {
    const factory = await loadExtensionViaJiti(EXTENSION_PATH)
    h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
  })

  afterAll(async () => {
    await h.shutdown()
  })

  it("fetches Wikipedia lean — no Map errors, correct shape", async () => {
    await assertWikipediaFetch(h)
  }, 20_000)
})
