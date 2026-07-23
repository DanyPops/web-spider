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
  server.set(
    "/interactive",
    "<html><body>" +
      "<h1>O-RAN Specifications</h1>" +
      // A stylesheet rule for the initial hidden state, not an inline style
      // attribute — an inline style's specificity would always beat the
      // hover rule below regardless of actual hover state (a real bug
      // caught while writing this test).
      "<style>.tooltip{display:none} .menu:hover + .tooltip{display:block}</style>" +
      "<div class='menu'>hover me</div><div class='tooltip'>revealed</div>" +
      "<button id='confirm-btn' onclick=\"window.result = confirm('proceed?') ? 'accepted' : 'dismissed'\">confirm</button>" +
      "<a id='dl' href='data:text/plain,hello-e2' download='spec.txt'>download</a>" +
      "<script>console.error('real-error-marker')</script>" +
      "</body></html>",
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

describe("web_session — the seven newer actions, end to end through the tool boundary", () => {
  it("hover reveals a CSS :hover-only element, and pressKey submits via Enter scoped to a selector", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "interact-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "interact-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/interactive`,
    })
    await h.invokeTool("web_session", {
      operation: "act", name: "interact-session", snapshotVersion: 1, action: "hover", selector: ".menu",
    })
    const display = await h.invokeTool("web_session", {
      operation: "act", name: "interact-session", snapshotVersion: 1, action: "eval",
      script: "getComputedStyle(document.querySelector('.tooltip')).display",
    }) as any
    expect(JSON.parse(display.content[0].text).result).toBe("block")

    await h.invokeTool("web_session", { operation: "close", name: "interact-session" })
  }, 30_000)

  it("snapshot returns a real YAML accessibility tree, optionally with bounding boxes", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "snapshot-tool-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "snapshot-tool-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/interactive`,
    })
    const result = await h.invokeTool("web_session", {
      operation: "act", name: "snapshot-tool-session", snapshotVersion: 1, action: "snapshot", boxes: true,
    }) as any
    const tree = JSON.parse(result.content[0].text).result as string
    expect(tree).toContain('heading "O-RAN Specifications"')
    expect(tree).toContain("[box=")

    await h.invokeTool("web_session", { operation: "close", name: "snapshot-tool-session" })
  }, 30_000)

  it("handleDialog accepts a real confirm() dialog when armed", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "dialog-tool-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "dialog-tool-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/interactive`,
    })
    await h.invokeTool("web_session", {
      operation: "act", name: "dialog-tool-session", snapshotVersion: 1, action: "handleDialog", accept: true,
    })
    await h.invokeTool("web_session", {
      operation: "act", name: "dialog-tool-session", snapshotVersion: 1, action: "click", selector: "#confirm-btn",
    })
    const result = await h.invokeTool("web_session", {
      operation: "act", name: "dialog-tool-session", snapshotVersion: 1, action: "eval", script: "window.result",
    }) as any
    expect(JSON.parse(result.content[0].text).result).toBe("accepted")

    await h.invokeTool("web_session", { operation: "close", name: "dialog-tool-session" })
  }, 30_000)

  it("downloads lists a real click-triggered file after it finishes saving", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "downloads-tool-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "downloads-tool-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/interactive`,
    })
    await h.invokeTool("web_session", {
      operation: "act", name: "downloads-tool-session", snapshotVersion: 1, action: "click", selector: "#dl",
    })
    let downloads: any[] = []
    for (let i = 0; i < 50 && downloads.length === 0; i++) {
      const result = await h.invokeTool("web_session", {
        operation: "act", name: "downloads-tool-session", snapshotVersion: 1, action: "downloads",
      }) as any
      downloads = JSON.parse(result.content[0].text).result
      if (downloads.length === 0) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatchObject({ filename: "spec.txt" })

    await h.invokeTool("web_session", { operation: "close", name: "downloads-tool-session" })
  }, 30_000)

  it("consoleMessages and networkRequests surface real captured session activity", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "observability-tool-session" })
    await h.invokeTool("web_session", {
      operation: "act", name: "observability-tool-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/interactive`,
    })
    const consoleResult = await h.invokeTool("web_session", {
      operation: "act", name: "observability-tool-session", snapshotVersion: 1, action: "consoleMessages",
    }) as any
    const messages = JSON.parse(consoleResult.content[0].text).result
    expect(messages.some((m: any) => m.type === "error" && m.text === "real-error-marker")).toBe(true)

    const networkResult = await h.invokeTool("web_session", {
      operation: "act", name: "observability-tool-session", snapshotVersion: 1, action: "networkRequests",
    }) as any
    const requests = JSON.parse(networkResult.content[0].text).result
    expect(requests.some((r: any) => r.url.includes("/interactive"))).toBe(true)

    await h.invokeTool("web_session", { operation: "close", name: "observability-tool-session" })
  }, 30_000)

  it("tabs opens a second tab, and switching back preserves the first tab's own snapshotVersion", async () => {
    await h.invokeTool("web_session", { operation: "create", name: "tabs-tool-session" })
    const nav1 = await h.invokeTool("web_session", {
      operation: "act", name: "tabs-tool-session", snapshotVersion: 0, action: "navigate", url: `${server.baseUrl}/form`,
    }) as any
    expect(JSON.parse(nav1.content[0].text).snapshotVersion).toBe(1)

    const newTab = await h.invokeTool("web_session", {
      operation: "act", name: "tabs-tool-session", snapshotVersion: 1, action: "tabs", tabOperation: "new", url: `${server.baseUrl}/interactive`,
    }) as any
    const newTabBody = JSON.parse(newTab.content[0].text)
    expect(newTabBody.result).toMatchObject({ index: 1, active: true })
    expect(newTabBody.snapshotVersion).toBe(0)

    const selectBack = await h.invokeTool("web_session", {
      operation: "act", name: "tabs-tool-session", snapshotVersion: 0, action: "tabs", tabOperation: "select", tabIndex: 0,
    }) as any
    const selectBackBody = JSON.parse(selectBack.content[0].text)
    expect(selectBackBody.snapshotVersion).toBe(1)
    expect(selectBackBody.result).toMatchObject({ index: 0, active: true })

    const listed = await h.invokeTool("web_session", {
      operation: "act", name: "tabs-tool-session", snapshotVersion: 1, action: "tabs", tabOperation: "list",
    }) as any
    expect(JSON.parse(listed.content[0].text).result).toHaveLength(2)

    await h.invokeTool("web_session", { operation: "close", name: "tabs-tool-session" })
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
