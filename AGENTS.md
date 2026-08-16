# Development Rules

Three packages: `web-spider` (fetch/crawl/search domain logic, vitest), `web-spider-daemon`
(the daemon -- session registry, a real `VehicleRegistry`, bun test), and `pi-web-spider` (the
Pi extension -- connects as a `VehicleClient`, exposes consolidated action-parameter tools like
`web_fetch`/`web_category` via `invokeVehicleOperation()`, vitest). See `@danypops/vehicle`'s
own AGENTS.md for the shared substrate all three build on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "bug fix: this
  used to...") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable.
- Read a file in full before a wide-ranging change to it.
- `pi-web-spider`'s tools are deliberately consolidated (one Pi tool, several backend operations
  behind an `action`/named-mode parameter -- `web_fetch`, `web_category`, `web_quotes`, ...), not
  the one-tool-per-Vehicle-operation default `registerVehicleTools()` would produce. When wiring
  a newly Vehicle-migrated operation into one of these tools, use `invokeVehicleOperation()`
  directly (the standalone Decorator from `@danypops/vehicle-client-pi`) inside the existing
  `execute()`, not a wholesale `registerVehicleTools()` swap that would fragment the tool.
- `withVehicleErrorParity()` (`web-spider-daemon/src/handlers/error-parity.ts`) preserves the
  legacy `/api/v1/ops` route's error-to-status mapping for every operation migrated onto the
  Vehicle protocol -- a handler-thrown error not already mapped through `defineErrorMapping`
  degrades to a generic internal-error/500 instead of its real category. Extend the mapping list
  there, don't special-case it per handler.
- SSRF/robots.txt/response-size guards (`ssrf-guard.ts`, `robots.ts`, response-size-bound tests)
  are security-relevant -- treat a change there as reviewed code, same discipline as a lockfile
  change.

## Commands

- `web-spider`/`pi-web-spider` use **vitest**; `web-spider-daemon` uses **bun test** -- check
  which package you're in before reaching for the wrong runner.
- Per-package: `cd packages/<pkg> && bun run check`, `bun run test` (or `test:unit` to skip the
  one real-Chromium/Playwright browser test file, which is sandbox-flaky and split out on
  purpose -- reach for `test:browser` only when you specifically need to exercise it).
- Whole workspace: `bun run check` (`bun run --filter '*' check`), `bun run test` (`--sequential`
  across packages -- real daemon ports don't tolerate unbounded parallelism), `bun run lint`
  (`biome check --write . && eslint packages --max-warnings 0`).
- Run the touched package's check + test:unit after every change, then the workspace-wide check
  before considering a change done.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` is a `peerDependency` of `pi-web-spider`, not a plain
  `dependency` -- it holds shared mutable module-level state that must exist as exactly one copy
  in the process. Never downgrade it back to `dependency`.
- The root `overrides` block pins shared deps like `malevich-tui-components` across the whole
  workspace -- `bun install -g`/per-package installs silently no-op against it; edit the
  `overrides` entry itself to bump a pinned version.
- Before trusting a test result, confirm the workspace's own declared dependency floor for a
  sibling package actually covers that sibling's current local version -- a stale floor makes
  bun silently resolve an old published copy instead of linking local source.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH for a backward-compatible change), check + test +
  lint locally, commit, push, then tag and push the tag. `@danypops/web-spider`/`pi-web-spider`
  use bare `v<version>`; `web-spider-daemon` uses `web-spider-daemon-v<version>` -- see
  `.github/workflows/publish.yml`. Push tags one at a time, never batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking

- Work here is tracked in the shared Papyrus task database (project root: this repo's own
  directory). `tasks.start` → implement → `tasks.set_gates` (a real, re-runnable command proving
  the fix) → `tasks.submit` → `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.
