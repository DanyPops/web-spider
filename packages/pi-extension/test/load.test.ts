/**
 * Extension load tests — two jiti modes.
 *
 * tryNative:false — Bun binary path. Class constructors from re-exported ESM
 *   packages silently become undefined here; the factory uses dynamic import()
 *   to avoid this.
 * tryNative:true  — Node ESM baseline.
 */

import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  createExtensionHarness,
  loadExtensionViaJiti,
} from "@earendil-works/pi-coding-agent/testing"

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(__dirname, "../src/index.ts")

// ── tryNative:false — Bun binary simulation ───────────────────────────────────

describe("extension load — tryNative:false (Bun binary simulation)", () => {
  it("loads without throwing", async () => {
    const factory = await loadExtensionViaJiti(EXTENSION_PATH)
    expect(typeof factory).toBe("function")
  })

  it("registers web_fetch when factory is called", async () => {
    const factory = await loadExtensionViaJiti(EXTENSION_PATH)
    const h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
    expect(h.tools.has("web_fetch")).toBe(true)
    await h.shutdown()
  })

  it("registers exactly one tool", async () => {
    const factory = await loadExtensionViaJiti(EXTENSION_PATH)
    const h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
    expect(h.tools.size).toBe(1)
    expect(h.tools.has("web_fetch")).toBe(true)
    await h.shutdown()
  })
})

// ── tryNative:true — Node ESM baseline ───────────────────────────────────────

describe("extension load — tryNative:true (Node ESM baseline)", () => {
  it("registers web_fetch", async () => {
    const { default: factory } = await import("../src/index.js")
    const h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
    expect(h.tools.has("web_fetch")).toBe(true)
    await h.shutdown()
  })

  it("execute() returns valid result on first call — no crash at the Map boundary", async () => {
    // The Map realm bug only surfaces on the first execute() call, not at
    // construction time. The e2e-jiti tests cover the production jiti context;
    // this guards the simpler failure of execute() crashing at all.
    const { default: factory } = await import("../src/index.js")
    const h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()

    const result = await h.invokeTool("web_fetch", {}) as { content: { text: string }[] }
    expect(result).toHaveProperty("content")
    const text = JSON.parse(result.content[0].text)
    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("total")
    expect(typeof text.total).toBe("number")

    await h.shutdown()
  })
})
