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
| Start a background session | `{ operation: "create", name: "…" }` |
| Give a human the wheel for CAPTCHA/login | `{ operation: "create", name: "…", headed: true, forceChromeChannel: true }` |
| Load a page | `{ operation: "act", name, snapshotVersion, action: "navigate", url }` |
| Click something | `{ operation: "act", ..., action: "click", selector }` |
| Reveal a hover-triggered menu/tooltip | `{ operation: "act", ..., action: "hover", selector }` |
| Press a key (Enter/Escape/Tab/arrows) | `{ operation: "act", ..., action: "pressKey", key }` |
| Type into a field | `{ operation: "act", ..., action: "type", selector, text }` |
| Choose a dropdown option | `{ operation: "act", ..., action: "select", selector, value }` (or `label`) |
| Wait for an async result | `{ operation: "act", ..., action: "waitFor", text }` (or `selector` / `loadState`) |
| Read a list of items | `{ operation: "act", ..., action: "queryText", selector }` |
| Read a table | `{ operation: "act", ..., action: "readTable", selector }` |
| Understand a page's structure (preferred over a screenshot for this) | `{ operation: "act", ..., action: "snapshot" }` |
| Accept a confirm()/prompt() dialog before it appears | `{ operation: "act", ..., action: "handleDialog", accept: true }` then trigger the action that opens it |
| Check what files a click has downloaded | `{ operation: "act", ..., action: "downloads" }` after the triggering click |
| Debug why something isn't working | `{ operation: "act", ..., action: "consoleMessages" }` / `{ ..., action: "networkRequests" }` |
| Open/list/switch/close browser tabs | `{ operation: "act", ..., action: "tabs", tabOperation: "new" \| "list" \| "select" \| "close" }` |
| Run arbitrary JS | `{ operation: "act", ..., action: "eval", script }` |
| Capture the page | `{ operation: "act", ..., action: "screenshot" }` |
| See what's open | `{ operation: "list" }` |
| Tear a session down | `{ operation: "close", name }` |

---

## Lifecycle

| Operation | Required parameters | Notes |
|---|---|---|
| `create` | `name` | Launches an isolated, single-use Playwright browser process for this name. `headed: true` opens a visible window for human takeover; it defaults to `false`. Optional `forceChromeChannel` (default `false`) uses the full installed Chrome instead of Playwright's bundled Chromium. |
| `list` | — | Lists every live session. |
| `close` | `name` | Tears the session's browser down. Always close sessions you no longer need — each one is a real, resource-consuming browser process (bounded: 5 concurrent sessions max). |
| `act` | `name`, `snapshotVersion`, `action` | Dispatches one action against the session's one persistent page. |

## Snapshot version — required, not busywork, and per-tab

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

## Human takeover for CAPTCHA, login, or consent

A headed session is the handoff point between agent automation and a real human. It does not solve
or bypass a challenge. It opens the session's isolated browser window so the user can complete the
step personally; the browser remains under `web_session` afterward with the same cookies, local
storage, tabs, and network listeners.

Recommended flow:

1. Create with `{ headed: true, forceChromeChannel: true }` for anti-bot-sensitive sites.
2. Navigate to the target page.
3. Tell the user the visible browser is ready and ask them to complete the challenge, then confirm.
4. After confirmation, call `snapshot`, `waitFor`, or `networkRequests` on the **same session** and
   continue extraction.

If a challenge is discovered in a session that was already created headless, a headless browser
cannot be made visible in place. Close it, recreate the same name with `headed: true`, navigate
again, and hand over the new visible window. Once a session was created headed, human and agent can
alternate control without recreating it.

Headed launch requires an available desktop/display. If the daemon is running on a displayless
server, Playwright returns an actionable launch error; use the feature on the user's desktop rather
than attempting to emulate a human challenge response.

Each named session owns one isolated browser process and one explicit browser context. Tabs in that
session therefore share cookies, HTTP cache, permissions, service workers, initialization hooks,
and same-origin `localStorage`; different named sessions share none of those. `sessionStorage`
remains scoped by normal browser top-level-page rules and must not be assumed to be shared between
tabs. Popups and tabs opened directly by the page or human are discovered automatically.

Every page also receives a stable opaque `pageId`. Its numeric `index` is only a backward-compatible
projection of the current open-tab order and can change when an earlier tab closes; `pageId` does
not change or get reused. Existing `tabIndex` inputs remain supported.

**Each tab tracks its own `snapshotVersion` independently** — a stale-snapshot check is
fundamentally about *one page's* navigation state, not the session as a whole. The `snapshotVersion`
in every `act` response reflects whichever tab is currently active; switching tabs via
`tabs(select)`/`tabs(new)` surfaces *that* tab's own already-tracked version, not tab 0's:

```json
// tab 0: act(navigate) twice -> { "snapshotVersion": 2, ... }
// tabs(new)             -> { "snapshotVersion": 0, ... }   <- fresh tab, its own count
// tabs(select, index:0) -> { "snapshotVersion": 2, ... }   <- tab 0's own history, untouched
```

---

## Actions (`act` only)

| Action | Parameters | Bumps snapshotVersion? | Notes |
|---|---|---|---|
| `navigate` | `url` | Yes | Loads a URL. |
| `click` | `selector` | No | |
| `hover` | `selector` | No | Reveals hover-triggered menus/tooltips — the only way to trigger CSS `:hover` state; click/focus do not. |
| `pressKey` | `key`, optional `selector` | No | Presses a keyboard key (e.g. `"Enter"`, `"Escape"`, `"Tab"`, `"ArrowLeft"`). With `selector`, focuses that element first. Without one, a global keyboard press — for keys like `Escape` with no natural target element. |
| `type` | `selector`, `text`, optional `clear` (default `true`) | No | Real per-key keyboard input (Playwright's `pressSequentially`), not a directly-set value — works with pages that have their own JS-bound keyboard handling. `clear: false` appends instead of replacing. |
| `select` | `selector`, one of `value` / `label` | No | Chooses a `<select>` option by its value attribute or visible label. |
| `waitFor` | exactly one of `selector` / `text` / `loadState`, optional `state` (with `selector`/`text` only) | No | Blocks until the condition is true, bounded by `timeoutMs` (Playwright's own default applies when omitted — never unbounded). Use this instead of guessing a delay. |
| `queryText` | `selector` | No | Trimmed text per element matching `selector`, in document order. Bounded to 200 items, 2000 characters each. |
| `readTable` | `selector` | No | Rows of trimmed cell text for the `<table>` matching `selector`. Bounded to 200 rows, 2000 characters per cell. |
| `snapshot` | optional `selector`, `depth`, `boxes`, `mode` | No | Returns a YAML accessibility-tree snapshot (roles, accessible names, ARIA attributes, hierarchy) via Playwright's current `ariaSnapshot()` API. **Prefer this over `screenshot` for understanding page structure** — it's cheaper, more precise, and directly describes what's interactable, matching the pattern used by Playwright's own reference AI-agent tooling. `selector` scopes to one element/subtree instead of the whole page. `depth` limits tree depth. `boxes: true` appends each node's bounding box (`[box=x,y,width,height]`, viewport-relative CSS pixels) — ties structure to real pixel coordinates without needing vision. `mode: "ai"` adds element references, does not wait for a matching element (throws immediately if missing), and includes `<iframe>` content. Bounded to 20,000 characters (truncated with a marker). Note: unlike every other action, an unspecified `timeoutMs` here still gets an explicit bounded default (Playwright's own real default for this specific method is no timeout at all). |
| `handleDialog` | `accept` (required), optional `promptText` | No | Arms a **one-shot** policy for the *next* native dialog (`alert`/`confirm`/`prompt`/`beforeunload`) that appears on the page, consumed on first use. Call this *before* the action expected to trigger the dialog (matching Playwright's own documented pattern). Without arming a policy, every dialog auto-dismisses — Playwright's own real default when no handler is registered, verified directly rather than assumed; there is no "hang" risk to guard against. `promptText` answers a `prompt()` dialog; ignored for other dialog types. |
| `downloads` | — | No | Returns every file downloaded on this page since session creation (most recent last, bounded to 20 entries): `{filename, path, url, failure}`. Each file has already been saved to disk by the time it appears here (a persistent listener registered at session creation, not a new interaction) — call this *after* the action expected to trigger a download, since a download may not finish before the triggering action's own response returns (verified empirically: Playwright's own recommended pattern races the download event against the triggering click rather than checking afterward). A real limitation: bounded by entry count, not total disk usage — a single very large file is not size-capped. |
| `consoleMessages` | — | No | Returns every console message (`log`/`warn`/`error`/`info`/`debug`) logged on the page since session creation: `{type, text, timestamp}`, bounded to 100 entries. Buffered by a persistent listener — not retroactively queryable, so it only ever reflects what happened *after* the session started. |
| `networkRequests` | optional `includeStatic` | No | Returns every network request/response observed since session creation: `{url, method, status, resourceType}`, bounded to 100 entries. Excludes successful static resources (`image`/`stylesheet`/`font`/`script`) by default, matching Playwright's own AI-agent tooling convention — `includeStatic: true` includes everything. |
| `tabs` | `tabOperation`, optional `tabIndex`/`url` | No† | Manages every page in the session's shared context, including human-created popups. `list`: every open tab as `{pageId, index, url, title, active}`; `pageId` is stable while `index` may shift after a close. `new`: opens a tab (optionally navigating it via `url`) and makes it active. `close`: closes a tab (defaults to active); if active closes, activation falls back to the tab now at that index, then the last remaining tab, or none. `select`: switches by compatibility `tabIndex`. Bounded to 10 tabs; an excess page-created popup is closed and not registered. † Doesn't bump `snapshotVersion` itself, but **`snapshotVersion` is per-tab, not per-session** — see below. |
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
| `headed` | `boolean` | create; show a visible browser for human takeover (default `false`) |
| `snapshotVersion` | `number` | act, required |
| `action` | `"navigate" \| "click" \| "hover" \| "pressKey" \| "type" \| "select" \| "waitFor" \| "queryText" \| "readTable" \| "snapshot" \| "handleDialog" \| "downloads" \| "consoleMessages" \| "networkRequests" \| "tabs" \| "eval" \| "screenshot"` | act, required |
| `url` | `string` | navigate, tabs (new, optional) |
| `selector` | `string` | click / hover / pressKey (optional) / type / select / waitFor / queryText / readTable / snapshot / screenshot (element-scoped) |
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
| `key` | `string` | pressKey, required |
| `includeStatic` | `boolean` | networkRequests |
| `tabOperation` | `"list" \| "new" \| "close" \| "select"` | tabs, required |
| `tabIndex` | `number` | tabs (required for select, optional for close) |
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
