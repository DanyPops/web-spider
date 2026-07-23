# `web_session` — API Reference

> Pi extension tool · `@danypops/pi-web-spider`

`web_session` gives you a persistent, named browser session — tmux-session semantics: create once,
act on the same page repeatedly, close when done. Use it for pages that need real interaction (typing
into a search box, selecting a dropdown, waiting on an async result, reading a results table) that a
single `web_fetch` call can't express. `web_fetch` remains the right tool for reading a page or a
site — `web_session` is for driving one.

---

## Quick decision guide

| Goal | Call |
|---|---|
| Start a session | `{ operation: "create", name: "…" }` |
| Load a page | `{ operation: "act", name, snapshotVersion, action: "navigate", url }` |
| Click something | `{ operation: "act", ..., action: "click", selector }` |
| Type into a field | `{ operation: "act", ..., action: "type", selector, text }` |
| Choose a dropdown option | `{ operation: "act", ..., action: "select", selector, value }` (or `label`) |
| Wait for an async result | `{ operation: "act", ..., action: "waitFor", text }` (or `selector` / `loadState`) |
| Read a list of items | `{ operation: "act", ..., action: "queryText", selector }` |
| Read a table | `{ operation: "act", ..., action: "readTable", selector }` |
| Understand a page's structure (preferred over a screenshot for this) | `{ operation: "act", ..., action: "snapshot" }` |
| Accept a confirm()/prompt() dialog before it appears | `{ operation: "act", ..., action: "handleDialog", accept: true }` then trigger the action that opens it |
| Check what files a click has downloaded | `{ operation: "act", ..., action: "downloads" }` after the triggering click |
| Run arbitrary JS | `{ operation: "act", ..., action: "eval", script }` |
| Capture the page | `{ operation: "act", ..., action: "screenshot" }` |
| See what's open | `{ operation: "list" }` |
| Tear a session down | `{ operation: "close", name }` |

---

## Lifecycle

| Operation | Required parameters | Notes |
|---|---|---|
| `create` | `name` | Launches an isolated, single-use Playwright browser process for this name. Optional `forceChromeChannel` (default `false`) forces the full installed Chrome channel instead of Playwright's own headless shell. |
| `list` | — | Lists every live session. |
| `close` | `name` | Tears the session's browser down. Always close sessions you no longer need — each one is a real, resource-consuming browser process (bounded: 5 concurrent sessions max). |
| `act` | `name`, `snapshotVersion`, `action` | Dispatches one action against the session's one persistent page. |

## Snapshot version — required, not busywork

Every `act` response includes `snapshotVersion`. Pass it back on your next `act` call for that
session. A stale value is **rejected** rather than silently acting on out-of-date state — the page
may have navigated or changed since you last observed it. `create` returns `snapshotVersion: 0` to
start with; `navigate` bumps it; every other action leaves it unchanged.

```json
// create → { "name": "s1", "snapshotVersion": 0, ... }
// act(navigate) → { "snapshotVersion": 1, ... }   ← use 1 for the next act() call
// act(click)    → { "snapshotVersion": 1, ... }   ← click doesn't bump it
```

Acting with a stale value throws a clear error rather than a silent wrong result — this is a
deliberate safety property, not friction to work around.

---

## Actions (`act` only)

| Action | Parameters | Bumps snapshotVersion? | Notes |
|---|---|---|---|
| `navigate` | `url` | Yes | Loads a URL. |
| `click` | `selector` | No | |
| `type` | `selector`, `text`, optional `clear` (default `true`) | No | Real per-key keyboard input (Playwright's `pressSequentially`), not a directly-set value — works with pages that have their own JS-bound keyboard handling. `clear: false` appends instead of replacing. |
| `select` | `selector`, one of `value` / `label` | No | Chooses a `<select>` option by its value attribute or visible label. |
| `waitFor` | exactly one of `selector` / `text` / `loadState`, optional `state` (with `selector`/`text` only) | No | Blocks until the condition is true, bounded by `timeoutMs` (Playwright's own default applies when omitted — never unbounded). Use this instead of guessing a delay. |
| `queryText` | `selector` | No | Trimmed text per element matching `selector`, in document order. Bounded to 200 items, 2000 characters each. |
| `readTable` | `selector` | No | Rows of trimmed cell text for the `<table>` matching `selector`. Bounded to 200 rows, 2000 characters per cell. |
| `snapshot` | optional `selector`, `depth`, `boxes`, `mode` | No | Returns a YAML accessibility-tree snapshot (roles, accessible names, ARIA attributes, hierarchy) via Playwright's current `ariaSnapshot()` API. **Prefer this over `screenshot` for understanding page structure** — it's cheaper, more precise, and directly describes what's interactable, matching the pattern used by Playwright's own reference AI-agent tooling. `selector` scopes to one element/subtree instead of the whole page. `depth` limits tree depth. `boxes: true` appends each node's bounding box (`[box=x,y,width,height]`, viewport-relative CSS pixels) — ties structure to real pixel coordinates without needing vision. `mode: "ai"` adds element references, does not wait for a matching element (throws immediately if missing), and includes `<iframe>` content. Bounded to 20,000 characters (truncated with a marker). Note: unlike every other action, an unspecified `timeoutMs` here still gets an explicit bounded default (Playwright's own real default for this specific method is no timeout at all). |
| `handleDialog` | `accept` (required), optional `promptText` | No | Arms a **one-shot** policy for the *next* native dialog (`alert`/`confirm`/`prompt`/`beforeunload`) that appears on the page, consumed on first use. Call this *before* the action expected to trigger the dialog (matching Playwright's own documented pattern). Without arming a policy, every dialog auto-dismisses — Playwright's own real default when no handler is registered, verified directly rather than assumed; there is no "hang" risk to guard against. `promptText` answers a `prompt()` dialog; ignored for other dialog types. |
| `downloads` | — | No | Returns every file downloaded on this page since session creation (most recent last, bounded to 20 entries): `{filename, path, url, failure}`. Each file has already been saved to disk by the time it appears here (a persistent listener registered at session creation, not a new interaction) — call this *after* the action expected to trigger a download, since a download may not finish before the triggering action's own response returns (verified empirically: Playwright's own recommended pattern races the download event against the triggering click rather than checking afterward). A real limitation: bounded by entry count, not total disk usage — a single very large file is not size-capped. |
| `eval` | `script` | No | Arbitrary JavaScript; returns its JSON-serializable result. Prefer the actions above when they fit — `eval` is the least structured, least auditable option. |
| `screenshot` | optional `fullPage`, `selector`, `scale` | No | Returns a PNG as a real image content block (not embedded in the JSON result). Defaults to viewport-only, matching Playwright's own real default. `fullPage: true` captures the whole scrollable page; `selector` captures just that one element's bounding box instead ("download only this graphical element for inspection") — mutually exclusive with `fullPage`. `scale: "css"` (default) is CSS-pixel-sized; `"device"` uses the real device pixel ratio. |

### `waitFor` in detail

Exactly one of `selector`, `text`, or `loadState` is required:

- `selector` — waits for an element (`state`: `visible` (default) / `hidden` / `attached` / `detached`).
- `text` — waits for the text to appear anywhere on the page (Playwright's own text locator).
- `loadState` — waits for a page navigation state (`load` / `domcontentloaded` / `networkidle`). `state` is not valid alongside `loadState`.

---

## Parameters (full reference)

| Parameter | Type | Used by |
|---|---|---|
| `operation` | `"create" \| "list" \| "close" \| "act"` | always, required |
| `name` | `string` | create / close / act |
| `forceChromeChannel` | `boolean` | create |
| `snapshotVersion` | `number` | act, required |
| `action` | `"navigate" \| "click" \| "type" \| "select" \| "waitFor" \| "queryText" \| "readTable" \| "snapshot" \| "handleDialog" \| "downloads" \| "eval" \| "screenshot"` | act, required |
| `url` | `string` | navigate |
| `selector` | `string` | click / type / select / waitFor / queryText / readTable / snapshot / screenshot (element-scoped) |
| `text` | `string` | type / waitFor |
| `clear` | `boolean` | type |
| `value` | `string` | select |
| `label` | `string` | select |
| `loadState` | `"load" \| "domcontentloaded" \| "networkidle"` | waitFor |
| `state` | `"visible" \| "hidden" \| "attached" \| "detached"` | waitFor |
| `script` | `string` | eval |
| `fullPage` | `boolean` | screenshot |
| `scale` | `"css" \| "device"` | screenshot |
| `depth` | `number` | snapshot |
| `boxes` | `boolean` | snapshot |
| `mode` | `"ai" \| "default"` | snapshot |
| `accept` | `boolean` | handleDialog, required |
| `promptText` | `string` | handleDialog |
| `timeoutMs` | `number` | any act action; Playwright's own default (bounded) applies when omitted |

---

## Auditing

Every `act` call is journaled by the daemon — content-free: selectors and enum values only, never
typed text, scripts, page content, or screenshot bytes. See the daemon's own
`packages/web-spider-daemon/src/domain/session-audit.ts` for the exact redaction rules.

---

## Relationship to `web_fetch`

`web_session` is a separate tool, not an extension of `web_fetch` — `web_fetch`'s contract is fixed
and never changes for this feature. Use `web_fetch` to read a page or crawl a site; reach for
`web_session` only when a page genuinely needs interaction `web_fetch` can't express (a search box
that must be typed into, a filter that must be applied, results that only render after a client-side
round-trip).
