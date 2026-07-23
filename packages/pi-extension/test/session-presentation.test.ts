import { describe, expect, it } from "vitest"
import type { Theme } from "@earendil-works/pi-coding-agent"
import { Text, visibleWidth } from "@earendil-works/pi-tui"
import {
  createSessionActDetails,
  createSessionLifecycleDetails,
  createSessionListDetails,
  parseSessionDetails,
  renderWebSessionCall,
  renderWebSessionResult,
  SessionResultCard,
} from "../src/session-presentation.js"

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
} as unknown as Theme

const render = (details: ReturnType<typeof createSessionActDetails>, expanded = false, width = 80) =>
  renderWebSessionResult(
    { content: [{ type: "text" as const, text: JSON.stringify({}) }], details },
    { expanded, isPartial: false },
    theme,
    { isPartial: false, lastComponent: undefined },
  ).render(width).join("\n")

describe("web_session dual-channel presentation", () => {
  it("renders compact calls for lifecycle operations and act actions", () => {
    const cases = [
      [{ operation: "create", name: "s1" }, "Create · s1"],
      [{ operation: "list" }, "List"],
      [{ operation: "close", name: "s1" }, "Close · s1"],
      [{ operation: "act", name: "s1", action: "click", selector: "#go" }, "click · s1 · #go"],
      [{ operation: "act", name: "s1", action: "navigate", url: "https://example.com" }, "navigate · s1 · https://example.com"],
      [{ operation: "act", name: "s1", action: "tabs", tabOperation: "select" }, "tabs · s1 · select"],
    ] as const
    for (const [args, expected] of cases) {
      expect(renderWebSessionCall(args, theme).render(120).join("\n")).toContain(expected)
    }
  })

  it("renders lifecycle outcomes for create/list/close", () => {
    expect(render(createSessionLifecycleDetails("create", "s1", { snapshotVersion: 0 }))).toContain("Session created")
    expect(render(createSessionLifecycleDetails("close", "s1", { closed: true }))).toContain("Session closed")
    const list = createSessionListDetails([{ name: "a", closed: false }, { name: "b", closed: true }])
    expect(render(list)).toContain("2 sessions")
    expect(render(list)).toContain("a")
    expect(render(list)).toContain("b")
  })

  it("shows a bounded collapsed preview and the full list when expanded, for a list-shaped action result", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`)
    const details = createSessionActDetails({ name: "s1", action: "queryText", snapshotVersion: 1, result: items })
    expect(render(details)).toContain("10 items")
    expect(render(details)).toContain("item-0")
    expect(render(details)).not.toContain("item-9") // beyond the collapsed preview
    expect(render(details, true)).toContain("item-9") // fully shown when expanded
  })

  it("formats readTable rows as readable cell previews, bounded", () => {
    const rows = [["Title", "Date"], ["O-RAN E2AP", "2025"]]
    const details = createSessionActDetails({ name: "s1", action: "readTable", snapshotVersion: 1, result: rows })
    expect(render(details)).toContain("2 rows")
    expect(render(details, true)).toContain("O-RAN E2AP │ 2025")
  })

  it("puts the snapshot's YAML tree only in the expanded body, never the collapsed preview", () => {
    const tree = "- heading \"Title\" [level=1]\n- link \"Home\""
    const details = createSessionActDetails({ name: "s1", action: "snapshot", snapshotVersion: 1, result: tree })
    expect(render(details)).not.toContain("heading")
    expect(render(details)).toContain("expand for details")
    expect(render(details, true)).toContain("heading \"Title\"")
  })

  it("never shows a misleading '… N more' hint for body-based results (a real bug caught manually: total used to double as a line count)", () => {
    const tree = "line one\nline two\nline three"
    const details = createSessionActDetails({ name: "s1", action: "snapshot", snapshotVersion: 1, result: tree })
    expect(render(details, true)).not.toContain("more")
    const evalDetails = createSessionActDetails({ name: "s1", action: "eval", snapshotVersion: 1, result: { a: 1, b: 2 } })
    expect(render(evalDetails, true)).not.toContain("more")
  })

  it("bounds an oversized body with a truncation marker, and parseSessionDetails rejects an oversized one", () => {
    const huge = "x".repeat(50_000)
    const details = createSessionActDetails({ name: "s1", action: "eval", snapshotVersion: 1, result: huge })
    expect(details.body!.length).toBeLessThan(huge.length)
    expect(details.body).toContain("[preview truncated]")
    expect(parseSessionDetails({ ...details, body: "y".repeat(50_000) })).toBeUndefined()
  })

  it("pretty-prints eval's JSON result only in expanded view", () => {
    const details = createSessionActDetails({ name: "s1", action: "eval", snapshotVersion: 1, result: { ok: true, count: 3 } })
    expect(render(details)).not.toContain("\"ok\": true")
    expect(render(details, true)).toContain("\"ok\": true")
  })

  it("summarizes tabs list/new/select/close outcomes distinctly", () => {
    const list = createSessionActDetails({
      name: "s1", action: "tabs", snapshotVersion: 1,
      result: [{ index: 0, url: "https://a.test", title: "A", active: false }, { index: 1, url: "https://b.test", title: "B", active: true }],
    })
    expect(render(list)).toContain("2 tabs")
    expect(render(list)).toContain("[0]")

    const created = createSessionActDetails({ name: "s1", action: "tabs", snapshotVersion: 1, result: { index: 1, url: "https://b.test", title: "B", active: true } })
    expect(render(created)).toContain("Tab 1 active")

    const closed = createSessionActDetails({ name: "s1", action: "tabs", snapshotVersion: 1, result: { closedIndex: 1, newActiveIndex: 0 } })
    expect(render(closed)).toContain("Tab 1 closed")
    expect(render(closed)).toContain("tab 0 active")
  })

  it("gives every scalar action (navigate/click/hover/pressKey/type/select/waitFor/handleDialog) a distinct, real summary", () => {
    const actions = ["navigate", "click", "hover", "pressKey", "type", "select", "waitFor", "handleDialog"]
    const summaries = actions.map((action) => render(createSessionActDetails({ name: "s1", action, snapshotVersion: 1 })))
    expect(new Set(summaries).size).toBe(actions.length) // every action gets its own wording, none collide
  })

  it("marks screenshot as captured without leaking image bytes into the rendered text", () => {
    const details = createSessionActDetails({ name: "s1", action: "screenshot", snapshotVersion: 1 })
    expect(render(details)).toContain("Screenshot captured")
    expect(JSON.stringify(details)).not.toMatch(/[A-Za-z0-9+/]{100,}/) // no base64-shaped blob anywhere in details
  })

  it("fits every rendered line within the requested width at 40/80/120 columns", () => {
    const details = createSessionActDetails({
      name: "a-fairly-long-session-name-for-width-testing",
      action: "readTable",
      snapshotVersion: 1,
      result: [["A very long cell value that should be truncated to fit the requested terminal width safely", "second"]],
    })
    for (const width of [40, 80, 120]) {
      const lines = renderWebSessionResult(
        { content: [{ type: "text" as const, text: "{}" }], details },
        { expanded: true, isPartial: false }, theme, { isPartial: false, lastComponent: undefined },
      ).render(width)
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
    }
  })

  it("shows a working indicator while partial, and falls back to raw content for missing/malformed details", () => {
    const partial = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "" }], details: createSessionLifecycleDetails("create", "s1") },
      { expanded: false, isPartial: true }, theme, { isPartial: true, lastComponent: undefined },
    ).render(40).join("\n")
    expect(partial).toContain("Working")

    const fallback = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "legacy bounded content" }], details: {} },
      { expanded: false, isPartial: false }, theme, { isPartial: false, lastComponent: undefined },
    ).render(40).join("\n")
    expect(fallback).toContain("legacy bounded content")

    const malformed: unknown = { ...createSessionLifecycleDetails("create", "s1"), total: -1 }
    expect(parseSessionDetails(malformed)).toBeUndefined()
  })

  it("reuses context.lastComponent across renders (Pi's documented component-reuse best practice)", () => {
    const first = createSessionActDetails({ name: "s1", action: "navigate", snapshotVersion: 1 })
    const component = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "{}" }], details: first },
      { expanded: false, isPartial: false }, theme, { isPartial: false, lastComponent: undefined },
    )
    expect(component).toBeInstanceOf(SessionResultCard)
    expect(component.render(80).join("\n")).toContain("Navigated")

    const second = createSessionActDetails({ name: "s1", action: "click", snapshotVersion: 1 })
    const reused = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "{}" }], details: second },
      { expanded: false, isPartial: false }, theme, { isPartial: false, lastComponent: component },
    )
    expect(reused).toBe(component)
    expect(reused.render(80).join("\n")).toContain("Clicked")
    expect(reused.render(80).join("\n")).not.toContain("Navigated")
  })

  it("clears cached render lines on invalidate() so a later render reflects updated state", () => {
    const details = createSessionActDetails({ name: "s1", action: "navigate", snapshotVersion: 1 })
    const component = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "{}" }], details },
      { expanded: false, isPartial: false }, theme, { isPartial: false, lastComponent: undefined },
    ) as SessionResultCard
    const lines1 = component.render(80)
    const lines2 = component.render(80)
    expect(lines2).toBe(lines1)
    component.invalidate()
    const lines3 = component.render(80)
    expect(lines3).not.toBe(lines1)
    expect(lines3.join("\n")).toBe(lines1.join("\n"))
  })

  it("renderWebSessionCall reuses a lastComponent Text instance instead of allocating a new one", () => {
    const previous = new Text("", 0, 0)
    const reused = renderWebSessionCall({ operation: "create", name: "s1" }, theme, { lastComponent: previous })
    expect(reused).toBe(previous)
    expect(reused.render(100).join("\n")).toContain("s1")

    const fresh = renderWebSessionCall({ operation: "create", name: "s1" }, theme, { lastComponent: undefined })
    expect(fresh).not.toBe(previous)
  })

  it("does not reuse a lastComponent of a different shape (falls back to constructing fresh)", () => {
    const details = createSessionActDetails({ name: "s1", action: "navigate", snapshotVersion: 1 })
    const unrelated = new Text("unrelated", 0, 0)
    const component = renderWebSessionResult(
      { content: [{ type: "text" as const, text: "{}" }], details },
      { expanded: false, isPartial: false }, theme, { isPartial: false, lastComponent: unrelated },
    )
    expect(component).not.toBe(unrelated)
    expect(component).toBeInstanceOf(SessionResultCard)
  })
})
