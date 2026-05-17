/**
 * Extension load tests.
 *
 * Two modes — mirrors how Pi actually loads extensions:
 *
 *   tryNative:false  The Bun binary mode. Class constructors from re-exported
 *                    ESM modules silently become undefined in this mode.
 *                    This is the failure class web-spider hit in production
 *                    before switching to dynamic import() in the factory.
 *
 *   tryNative:true   Node ESM baseline. Used for comparison.
 *
 * Uses loadExtensionViaJiti + createExtensionHarness from
 * @earendil-works/pi-coding-agent/testing rather than hand-rolling a stub.
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
    // Direct import — no jiti interop concerns
    const { default: factory } = await import("../src/index.js")
    const h = createExtensionHarness(factory, { cwd: "/tmp" })
    await h.boot()
    expect(h.tools.has("web_fetch")).toBe(true)
    await h.shutdown()
  })
})
