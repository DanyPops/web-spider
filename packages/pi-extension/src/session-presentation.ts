import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent"
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui"
import {
  COLLAPSED_ITEM_PREVIEW,
  DETAILS_MAX_BODY_CHARACTERS,
  DETAILS_MAX_FIELD_CHARACTERS,
  DETAILS_MAX_ITEMS,
  DETAILS_MAX_SERIALIZED_CHARACTERS,
  DETAILS_VERSION,
  EXPANDED_PRIMARY_MAX_LINES,
} from "./constants.js"

/**
 * web_session's own dual-channel presentation — mirrors presentation.ts's
 * WebPresentationDetails shape and conventions exactly (version/kind
 * discriminator, bounded fields, a generic bounded "items" preview array)
 * so the two tools in this package stay visually and structurally
 * consistent, extended for web_session's much wider action surface (17
 * action variants across create/list/close/act, each with a different
 * result shape) by carrying a pre-formatted, already-bounded preview
 * instead of the raw heterogeneous daemon payload — matching Papyrus's own
 * principle (docs/TOOL_RENDERING_DESIGN.md): "details" is a presentation
 * DTO the renderer builds from, never a raw passthrough of the tool result.
 */

export type SessionOperation = "create" | "list" | "close" | "act"

export interface SessionPresentationDetails {
  version: typeof DETAILS_VERSION
  kind: "web-session"
  operation: SessionOperation
  action?: string
  name?: string
  snapshotVersion?: number
  /** One-line human summary, e.g. "Navigated", "12 rows", "2 tabs". */
  summary: string
  /** Bounded, already-formatted preview rows (queryText items, table rows, tab list, console messages, ...). */
  items: string[]
  /** Total item count before bounding, for an accurate "N more" hint. */
  total: number
  /** Full-content preview for expanded view only (e.g. the snapshot's YAML tree, eval's JSON result) — bounded separately, never duplicated into items. */
  body?: string
  hasImage?: boolean
  closed?: boolean
  truncated: boolean
}

function bounded(value: unknown, max = DETAILS_MAX_FIELD_CHARACTERS): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function boundedItems(rows: string[]): { items: string[]; total: number; truncated: boolean } {
  const total = rows.length
  const items = rows.slice(0, DETAILS_MAX_ITEMS).map((row) => row.slice(0, DETAILS_MAX_FIELD_CHARACTERS))
  return { items, total, truncated: total > items.length }
}

/** Bounds a body preview string (snapshot's YAML tree, eval's JSON) to a fixed character budget — details must stay bounded and serializable regardless of the daemon's own, larger content bounds. */
function boundedBody(value: string): string {
  if (value.length <= DETAILS_MAX_BODY_CHARACTERS) return value
  return `${value.slice(0, DETAILS_MAX_BODY_CHARACTERS)}\n… [preview truncated]`
}

/** Renders one table row as a single, readable preview line — cells joined, each individually bounded first. */
function tableRowPreview(row: unknown): string {
  if (!Array.isArray(row)) return String(row).slice(0, DETAILS_MAX_FIELD_CHARACTERS)
  return row.map((cell) => String(cell).replace(/\s+/g, " ").trim().slice(0, 80)).join(" │ ")
}

/**
 * Shapes the daemon's session.act result (whatever action-specific shape
 * it has) into a bounded presentation DTO. Kept as one function (rather
 * than per-action files) since every branch is a few lines and the
 * variety is the point — see docs/TOOL_RENDERING_DESIGN.md's action-matrix
 * precedent for why a wide, flat switch is the right shape here, not
 * premature per-action abstraction.
 */
export function createSessionActDetails(input: {
  name: string
  action: string
  snapshotVersion: number
  result?: unknown
}): SessionPresentationDetails {
  const base = {
    version: DETAILS_VERSION,
    kind: "web-session" as const,
    operation: "act" as const,
    action: input.action,
    name: input.name,
    snapshotVersion: input.snapshotVersion,
  }

  switch (input.action) {
    case "navigate": return { ...base, summary: "Navigated", items: [], total: 0, truncated: false }
    case "click": return { ...base, summary: "Clicked", items: [], total: 0, truncated: false }
    case "hover": return { ...base, summary: "Hovered", items: [], total: 0, truncated: false }
    case "pressKey": return { ...base, summary: "Key pressed", items: [], total: 0, truncated: false }
    case "type": return { ...base, summary: "Typed", items: [], total: 0, truncated: false }
    case "select": return { ...base, summary: "Option selected", items: [], total: 0, truncated: false }
    case "waitFor": return { ...base, summary: "Condition met", items: [], total: 0, truncated: false }
    case "handleDialog": return { ...base, summary: "Dialog policy armed", items: [], total: 0, truncated: false }

    case "queryText": {
      const rows = Array.isArray(input.result) ? input.result.map((v) => String(v)) : []
      const { items, total, truncated } = boundedItems(rows)
      return { ...base, summary: `${total} item${total === 1 ? "" : "s"}`, items, total, truncated }
    }
    case "readTable": {
      const rows = Array.isArray(input.result) ? input.result.map(tableRowPreview) : []
      const { items, total, truncated } = boundedItems(rows)
      return { ...base, summary: `${total} row${total === 1 ? "" : "s"}`, items, total, truncated }
    }
    case "downloads": {
      const rows = Array.isArray(input.result)
        ? input.result.map((d) => bounded(typeof d === "object" && d && "filename" in d ? String((d as { filename: unknown }).filename) : String(d)) ?? "")
        : []
      const { items, total, truncated } = boundedItems(rows)
      return { ...base, summary: `${total} download${total === 1 ? "" : "s"}`, items, total, truncated }
    }
    case "consoleMessages": {
      const rows = Array.isArray(input.result)
        ? input.result.map((m) => {
          const msg = m as { type?: unknown; text?: unknown }
          return `[${bounded(String(msg.type ?? "log"), 20)}] ${bounded(String(msg.text ?? ""), 200) ?? ""}`
        })
        : []
      const { items, total, truncated } = boundedItems(rows)
      return { ...base, summary: `${total} console message${total === 1 ? "" : "s"}`, items, total, truncated }
    }
    case "networkRequests": {
      const rows = Array.isArray(input.result)
        ? input.result.map((r) => {
          const req = r as { method?: unknown; status?: unknown; url?: unknown }
          return `${bounded(String(req.method ?? ""), 10)} ${bounded(String(req.status ?? ""), 6)} ${bounded(String(req.url ?? ""), 200) ?? ""}`
        })
        : []
      const { items, total, truncated } = boundedItems(rows)
      return { ...base, summary: `${total} request${total === 1 ? "" : "s"}`, items, total, truncated }
    }
    case "tabs": {
      if (Array.isArray(input.result)) {
        const rows = input.result.map((t) => {
          const tab = t as { index?: unknown; url?: unknown; title?: unknown; active?: unknown }
          return `${tab.active ? "●" : "○"} [${tab.index}] ${bounded(String(tab.title || tab.url || ""), 60) ?? ""}`
        })
        const { items, total, truncated } = boundedItems(rows)
        return { ...base, summary: `${total} tab${total === 1 ? "" : "s"}`, items, total, truncated }
      }
      if (input.result && typeof input.result === "object" && "closedIndex" in input.result) {
        const r = input.result as { closedIndex: number; newActiveIndex: number | null }
        return { ...base, summary: `Tab ${r.closedIndex} closed${r.newActiveIndex !== null ? ` · tab ${r.newActiveIndex} active` : ""}`, items: [], total: 0, truncated: false }
      }
      if (input.result && typeof input.result === "object" && "index" in input.result) {
        const r = input.result as { index: number }
        return { ...base, summary: `Tab ${r.index} active`, items: [], total: 0, truncated: false }
      }
      return { ...base, summary: "Tabs", items: [], total: 0, truncated: false }
    }
    case "snapshot": {
      // body/lineCount are a separate axis from items/total (which drive the
      // generic "N more" hint below the items list) — total stays 0 here so
      // that hint never fires; the body's own bounding (EXPANDED_PRIMARY_MAX_LINES)
      // carries its own, separate "N lines omitted" message in the renderer.
      // A real bug caught while manually previewing this exact case: setting
      // total to the line count produced a misleading "N more" hint that
      // still showed even when the body below it already rendered everything.
      const text = typeof input.result === "string" ? input.result : ""
      const lineCount = text.length === 0 ? 0 : text.split("\n").length
      return { ...base, summary: `Accessibility snapshot · ${lineCount} line${lineCount === 1 ? "" : "s"}`, items: [], total: 0, truncated: false, body: boundedBody(text) }
    }
    case "screenshot": return { ...base, summary: "Screenshot captured", items: [], total: 0, truncated: false, hasImage: true }
    case "eval": {
      let pretty: string
      try { pretty = JSON.stringify(input.result, null, 2) ?? "undefined" } catch { pretty = String(input.result) }
      return { ...base, summary: "Eval result", items: [], total: 0, truncated: false, body: boundedBody(pretty) }
    }
    default:
      return { ...base, summary: input.action, items: [], total: 0, truncated: false }
  }
}

export function createSessionLifecycleDetails(
  operation: "create" | "close",
  name: string,
  extra: { snapshotVersion?: number; closed?: boolean } = {},
): SessionPresentationDetails {
  return {
    version: DETAILS_VERSION,
    kind: "web-session",
    operation,
    name,
    snapshotVersion: extra.snapshotVersion,
    closed: extra.closed,
    summary: operation === "create" ? "Session created" : "Session closed",
    items: [],
    total: 0,
    truncated: false,
  }
}

export function createSessionListDetails(sessions: Array<{ name: string; closed: boolean }>): SessionPresentationDetails {
  const rows = sessions.map((s) => `${s.closed ? "· closed" : "● live"}  ${s.name}`)
  const { items, total, truncated } = boundedItems(rows)
  return {
    version: DETAILS_VERSION,
    kind: "web-session",
    operation: "list",
    summary: `${total} session${total === 1 ? "" : "s"}`,
    items,
    total,
    truncated,
  }
}

const OPERATIONS = new Set<SessionOperation>(["create", "list", "close", "act"])

export function parseSessionDetails(value: unknown): SessionPresentationDetails | undefined {
  try {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > DETAILS_MAX_SERIALIZED_CHARACTERS) return undefined
    const details = value as Record<string, unknown>
    if (details.version !== DETAILS_VERSION || details.kind !== "web-session") return undefined
    if (typeof details.operation !== "string" || !OPERATIONS.has(details.operation as SessionOperation)) return undefined
    if (typeof details.summary !== "string" || details.summary.length > DETAILS_MAX_FIELD_CHARACTERS) return undefined
    if (!Array.isArray(details.items) || details.items.length > DETAILS_MAX_ITEMS) return undefined
    if (!details.items.every((item) => typeof item === "string" && item.length <= DETAILS_MAX_FIELD_CHARACTERS)) return undefined
    if (typeof details.total !== "number" || !Number.isSafeInteger(details.total) || details.total < 0) return undefined
    if (typeof details.truncated !== "boolean") return undefined
    if (details.body !== undefined && (typeof details.body !== "string" || details.body.length > DETAILS_MAX_BODY_CHARACTERS + 64)) return undefined
    return value as SessionPresentationDetails
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Call header
// ---------------------------------------------------------------------------

function argPreview(args: Record<string, unknown>): string | undefined {
  for (const key of ["selector", "url", "key", "value", "label", "text", "tabOperation"]) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 60)
  }
  return undefined
}

function callText(args: Record<string, unknown>): string {
  const operation = typeof args.operation === "string" ? args.operation : "act"
  const name = typeof args.name === "string" ? args.name : undefined
  if (operation !== "act") return [operation[0]!.toUpperCase() + operation.slice(1), name].filter(Boolean).join(" · ")
  const action = typeof args.action === "string" ? args.action : "act"
  const preview = argPreview(args)
  return [action, name, preview].filter(Boolean).join(" · ")
}

export interface SessionCallContext {
  lastComponent: Component | undefined
}

/** Mirrors renderWebFetchCall's Text-reuse pattern exactly (docs/extensions.md's documented renderCall best practice). */
export function renderWebSessionCall(args: Record<string, unknown>, theme: Theme, context: SessionCallContext = { lastComponent: undefined }): Text {
  const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0)
  text.setText(theme.fg("toolTitle", theme.bold(truncateToWidth(callText(args), 160))))
  return text
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

function fallbackText(result: AgentToolResult<unknown>): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
}

/**
 * Reusable width-cached result card, same shape/caching discipline as
 * presentation.ts's WebResultCard and Papyrus's ArtifactCard/ArtifactListCard
 * (see docs/tui.md "Performance" and "Invalidation and Theme Changes").
 */
export class SessionResultCard implements Component {
  private details: SessionPresentationDetails
  private expanded: boolean
  private theme: Theme
  private cachedWidth: number | undefined
  private cachedLines: string[] | undefined

  constructor(details: SessionPresentationDetails, expanded: boolean, theme: Theme) {
    this.details = details
    this.expanded = expanded
    this.theme = theme
  }

  update(details: SessionPresentationDetails, expanded: boolean, theme: Theme): void {
    this.details = details
    this.expanded = expanded
    this.theme = theme
    this.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines

    const details = this.details
    const theme = this.theme
    const expanded = this.expanded
    const identity = [details.name, details.snapshotVersion !== undefined ? `v${details.snapshotVersion}` : undefined].filter(Boolean).join(" · ")
    const header = [theme.fg("success", `✓ ${details.summary}`), identity ? theme.fg("dim", identity) : undefined].filter(Boolean).join("  ")
    const lines = [truncateToWidth(header, safeWidth)]

    const shown = expanded ? details.items : details.items.slice(0, COLLAPSED_ITEM_PREVIEW)
    for (const item of shown) lines.push(truncateToWidth(theme.fg("text", `  ${item}`), safeWidth))
    const omitted = details.total - shown.length
    if (omitted > 0) lines.push(truncateToWidth(theme.fg("muted", `  … ${omitted} more${expanded ? "" : " · expand for details"}`), safeWidth))

    if (expanded && details.body) {
      lines.push("")
      const bodyLines = new Text(theme.fg("mdCode", details.body), 0, 0).render(safeWidth)
      const capped = bodyLines.length > EXPANDED_PRIMARY_MAX_LINES
        ? [...bodyLines.slice(0, EXPANDED_PRIMARY_MAX_LINES), theme.fg("warning", `… ${bodyLines.length - EXPANDED_PRIMARY_MAX_LINES} lines omitted`)]
        : bodyLines
      lines.push(...capped)
    } else if (!expanded && details.body) {
      lines.push(truncateToWidth(theme.fg("dim", "  expand for details"), safeWidth))
    }

    this.cachedWidth = safeWidth
    this.cachedLines = lines
    return lines
  }

  invalidate(): void {
    this.cachedWidth = undefined
    this.cachedLines = undefined
  }
}

export interface SessionResultContext {
  isPartial: boolean
  lastComponent: Component | undefined
}

export function renderWebSessionResult(
  result: AgentToolResult<unknown>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: SessionResultContext,
): Component {
  if (options.isPartial || context.isPartial) return new Text(theme.fg("accent", "Working…"), 0, 0)
  const details = parseSessionDetails(result.details)
  if (!details) return new Text(theme.fg("toolOutput", fallbackText(result)), 0, 0)

  const previous = context.lastComponent instanceof SessionResultCard ? context.lastComponent : undefined
  if (previous) {
    previous.update(details, options.expanded, theme)
    return previous
  }
  return new SessionResultCard(details, options.expanded, theme)
}
