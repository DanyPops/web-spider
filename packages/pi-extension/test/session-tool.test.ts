/**
 * Real end-to-end coverage for the web_session tool — a thin pass-through
 * to the daemon's session.create/list/close/act operations. Exercises a
 * real isolated daemon and a real (locally launched) Playwright browser,
 * not mocks: this tool's entire job is faithfully forwarding parameters,
 * so the daemon's own extensive session-service test suite is the right
 * place for exhaustive per-action behavior; this file verifies the tool
 * boundary itself (schema registration, parameter forwarding, error
 * propagation, and the one piece of tool-specific logic: screenshot's
 * image content block).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtensionHarness, type ExtensionHarness } from "./harness/index.ts"
import { isolatedDaemonEnv, type IsolatedDaemonEnv } from "./daemon-isolation.js"
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js"
import piFactory from "../src/index.js"

let h: ExtensionHarness
let isolated: IsolatedDaemonEnv
let server: FixtureServer

beforeAll(async () => {
  isolated = isolatedDaemonEnv("pi-web-spider-session-tool-test-")
  server = await startFixtureServer()
  server.set(
    "/form",
    "<html><body><input id='q' type='text'><ul><li>E2 Application Protocol</li><li>E2SM-KPM</li></ul></body></html>",
    "text/html",
  )
  h = createExtensionHarness(piFactory, { cwd: "/tmp", env: isolated.env })
  await h.boot()
}, 30_000)

afterAll(async () => {
  await h.shutdown()
  await server.close()
  isolated.cleanup()
})

describe("web_session — tool registration", () => {
  it("registers with a parameters schema and no custom rendering (default Pi rendering is fine for v1)", () => {
    const definition = h.tools.get("web_session")?.definition
    expect(definition).toBeDefined()
    expect(definition?.parameters).toBeDefined()
  })
})

describe("web_session — real end-to-end lifecycle", () => {
  it("create → act(navigate) → act(type) → act(queryText) → close, with real snapshotVersion tracking", async () => {
    const created = await h.invokeTool("web_session", { operation: "create", name: "e2e-session" }) as any
    const createdBody = JSON.parse(created.content[0].text)
    expect(createdBody).toMatchObject({ name: "e2e-session", snapshotVersion: 0, closed: false })

    const navigated = await h.invokeTool("web_session", {
      operation: "act", name: "e2e-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/form`,
    }) as any
    const navigatedBody = JSON.parse(navigated.content[0].text)
    expect(navigatedBody).toMatchObject({ action: "navigate", snapshotVersion: 1 })

    const typed = await h.invokeTool("web_session", {
      operation: "act", name: "e2e-session", snapshotVersion: 1, action: "type", selector: "#q", text: "E2",
    }) as any
    expect(JSON.parse(typed.content[0].text)).toMatchObject({ action: "type", snapshotVersion: 1 })

    const queried = await h.invokeTool("web_session", {
      operation: "act", name: "e2e-session", snapshotVersion: 1, action: "queryText", selector: "li",
    }) as any
    expect(JSON.parse(queried.content[0].text).result).toEqual(["E2 Application Protocol", "E2SM-KPM"])

    const listed = await h.invokeTool("web_session", { operation: "list" }) as any
    expect(JSON.parse(listed.content[0].text).sessions.map((s: any) => s.name)).toContain("e2e-session")

    const closed = await h.invokeTool("web_session", { operation: "close", name: "e2e-session" }) as any
    expect(JSON.parse(closed.content[0].text)).toEqual({ name: "e2e-session", closed: true })
  }, 30_000)

  it("screenshot returns both a text summary and a real image content block", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "screenshot-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "screenshot-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/form`,
    })
    const result = await h.invokeTool("web_session", {
      operation: "act", name: "screenshot-session", snapshotVersion: 1, action: "screenshot",
    }) as any

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("text")
    const summary = JSON.parse(result.content[0].text)
    expect(summary).toMatchObject({ action: "screenshot", snapshotVersion: 1 })
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect(typeof result.content[1].data).toBe("string")
    expect(result.content[1].data.length).toBeGreaterThan(0)
    // The image bytes never leak into details or the text summary.
    expect(JSON.stringify(summary)).not.toContain(result.content[1].data)

    await h.invokeTool("web_session", { operation: "close", name: "screenshot-session" })
  }, 30_000)
})

describe("web_session — validation and error propagation", () => {
  it("requires name for create", async () => {
    await expect(h.invokeTool("web_session", { operation: "create" }))
      .rejects.toThrow("name is required for operation=create")
  })

  it("requires name for act", async () => {
    await expect(h.invokeTool("web_session", { operation: "act", snapshotVersion: 0, action: "click" }))
      .rejects.toThrow("name is required for operation=act")
  })

  it("requires snapshotVersion for act", async () => {
    await expect(h.invokeTool("web_session", { operation: "act", name: "x", action: "click" }))
      .rejects.toThrow("snapshotVersion is required for operation=act")
  })

  it("requires action for act", async () => {
    await expect(h.invokeTool("web_session", { operation: "act", name: "x", snapshotVersion: 0 }))
      .rejects.toThrow("action is required for operation=act")
  })

  it("propagates a real daemon error (unknown session) through Pi's native error channel", async () => {
    await expect(h.invokeTool("web_session", {
      operation: "act", name: "does-not-exist", snapshotVersion: 0, action: "click", selector: "#x",
    })).rejects.toThrow("web_session failed")
  })

  it("propagates a real stale-snapshot rejection", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "stale-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "stale-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/form`,
    })
    await expect(h.invokeTool("web_session", {
      operation: "act", name: "stale-session", snapshotVersion: 0, action: "click", selector: "#q",
    })).rejects.toThrow("snapshot version mismatch")
    await h.invokeTool("web_session", { operation: "close", name: "stale-session" })
  }, 30_000)
})
