/**
 * Extension load test — verifies the extension factory loads and registers
 * its tool without error under jiti (the loader pi uses for extensions).
 *
 * This catches "not a constructor" and similar interop failures that only
 * surface when jiti's Babel transform runs, not in plain Node ESM tests.
 */

import { createJiti } from "jiti"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = join(__dirname, "../src/index.ts")

/** Minimal ExtensionAPI mock — just captures registerTool calls. */
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

describe("extension load via jiti", () => {
  it("loads without throwing", async () => {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    const mod = await jiti.import(EXTENSION_PATH, { default: true })
    expect(typeof mod).toBe("function")
  })

  it("registers web_fetch tool when factory is called", async () => {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void> | void
    const { api, tools } = makeMockApi()
    await factory(api)
    expect(tools).toContain("web_fetch")
    expect(api.registerTool).toHaveBeenCalledOnce()
  })

  it("registers exactly one tool", async () => {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    const factory = await jiti.import(EXTENSION_PATH, { default: true }) as (api: unknown) => Promise<void> | void
    const { api, tools } = makeMockApi()
    await factory(api)
    expect(tools).toHaveLength(1)
  })
})
