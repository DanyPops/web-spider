import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts"
import { isolatedDaemonEnv, type IsolatedDaemonEnv } from "./daemon-isolation.js"
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js"
import piFactory from "../src/index.js"

let h: ExtensionHarness
let isolated: IsolatedDaemonEnv
let server: FixtureServer

beforeAll(async () => {
  isolated = isolatedDaemonEnv("pi-web-spider-execute-contract-test-")
  server = await startFixtureServer()
  h = createExtensionHarness(piFactory, { cwd: "/tmp", env: isolated.env })
  await h.boot()
})

afterAll(async () => {
  await h.shutdown()
  await server.close()
  isolated.cleanup()
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
    // A real robots.txt served by the real (isolated) daemon's own RobotsCache
    // fetch — replaces mocking globalThis.fetch, which the daemon (a separate
    // process) never sees.
    server.set("/robots.txt", "User-agent: *\nDisallow: /private", "text/plain")
    server.set("/private", "<html><body><article><h1>Secret</h1><p>Should never be fetched.</p></article></body></html>")

    const result = await h.invokeTool("web_fetch", { url: `${server.baseUrl}/private` }) as any
    expect(JSON.parse(result.content[0].text)).toMatchObject({ blocked: true, reason: "robots.txt" })
    expect(result.details).toMatchObject({ kind: "web", status: "blocked", blockedBy: "robots.txt" })
  })
})

describe("ingest: explicit opt-in Papyrus wiring", () => {
  it("never calls papyrus.ingest when ingest is omitted (default behavior unchanged)", async () => {
    server.set("/plain", "<html><body><article><h1>Plain</h1><p>No mesh.</p></article></body></html>")
    const result = await h.invokeTool("web_fetch", { url: `${server.baseUrl}/plain`, format: "lean" }) as any
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("papyrus")
    expect(result.details.papyrusDocs).toBeUndefined()
  })

  it("forwards ingest:true for a single-page fetch to the daemon's papyrus.ingest op, which fails closed with no Papyrus daemon reachable in this isolated test environment", async () => {
    server.set("/ingest-me", "<html><body><article><h1>Ingest me</h1><p>Worth keeping.</p></article></body></html>")
    await expect(h.invokeTool("web_fetch", { url: `${server.baseUrl}/ingest-me`, format: "lean", ingest: true }))
      .rejects.toThrow(/Papyrus daemon is not running|Papyrus daemon state is stale/)
  })

  // The search-path wiring (maybeIngestSearch) uses the exact same call() helper and
  // papyrus.ingest operation as the fetch path exercised above; a live-network search-
  // engine round trip isn't repeated here to avoid a flaky, network-dependent test.
  // Search-specific mapping/bounding is covered by web-spider-daemon's
  // papyrus-mapping.test.ts and papyrus-ingest-service.test.ts.
})
