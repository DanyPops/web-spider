/**
 * Extension E2E load test.
 *
 * Simulates how pi loads extensions: via jiti with tryNative:false (the
 * setting pi uses in its compiled Bun binary). This is the mode that causes
 * class constructors and factory functions from re-exported modules to appear
 * undefined — a failure class that plain ESM import() tests never catch.
 *
 * Run this test whenever the extension or library changes.
 */

import { createJiti } from "jiti"
import { createRequire } from "node:module"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(__dirname, "../src/index.ts")

// Resolve jiti from the extension's own node_modules so module resolution
// starts from the right directory — not from vitest's cwd (pi-mono).
const require = createRequire(import.meta.url)
const jitiPath = require.resolve("jiti")

/** Minimal ExtensionAPI mock — captures registerTool calls. */
function makeMockApi() {
  const tools: string[] = []
  const api = {
    registerTool: vi.fn((tool: { name: string }) => { tools.push(tool.name) }),
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    appendEntry: vi.fn(),
  }
  return { api, tools }
}

// Use the extension directory as the jiti base — this ensures @dpopsuev/web-spider
// resolves from the extension's node_modules, not from the test runner's cwd.
const JITI_BASE = `file://${join(__dirname, "../src/index.ts")}`

describe("extension load — tryNative:false (Bun binary simulation)", () => {
  it("loads without throwing", async () => {
    const { createJiti: cj } = await import(jitiPath)
    const jiti = cj(JITI_BASE, { moduleCache: false, tryNative: false })
    const mod = await jiti.import(EXTENSION_PATH, { default: true })
    expect(typeof mod).toBe("function")
  })

  it("registers web_fetch when factory is called", async () => {
    const { createJiti: cj } = await import(jitiPath)
    const jiti = cj(JITI_BASE, { moduleCache: false, tryNative: false })
    const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void>
    const { api, tools } = makeMockApi()
    await factory(api)
    expect(tools).toContain("web_fetch")
    expect(api.registerTool).toHaveBeenCalled()
  })

  it("registers exactly four tools", async () => {
    const { createJiti: cj } = await import(jitiPath)
    const jiti = cj(JITI_BASE, { moduleCache: false, tryNative: false })
    const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void>
    const { api, tools } = makeMockApi()
    await factory(api)
    expect(tools).toHaveLength(4)
    expect(tools).toContain("web_tree")
    expect(tools).toContain("web_query")
    expect(tools).toContain("web_navigate")
  })
})

describe("extension load — tryNative:true (Node ESM baseline)", () => {
  it("registers web_fetch", async () => {
    const jiti = createJiti(JITI_BASE, { moduleCache: false, tryNative: true })
    const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void>
    const { api, tools } = makeMockApi()
    await factory(api)
    expect(tools).toContain("web_fetch")
  })
})
