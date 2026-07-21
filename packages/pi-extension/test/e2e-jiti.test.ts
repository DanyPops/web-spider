/**
 * E2E tests using the production jiti load path (tryNative:true + alias map).
 *
 * vi.mock() operates in vitest's module registry, which the extension factory
 * bypasses via dynamic import(). These tests run the extension in a subprocess
 * via mock-pi-cli.mjs so the real jiti context is exercised end-to-end.
 */

import { mkdirSync } from "node:fs"
import { spawn }  from "node:child_process"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { readDaemonHandle, resolveWebSpiderPaths } from "../src/daemon-client.js"

const __dirname   = dirname(fileURLToPath(import.meta.url))
const CLI         = resolve(__dirname, "fixtures/mock-pi-cli.mjs")
const EXTENSION   = resolve(__dirname, "../src/index.ts")
const CACHE_DIR = "/tmp/ws-e2e-jiti"

// ---------------------------------------------------------------------------
// Helper — run mock-pi-cli and collect emitted NDJSON events
// ---------------------------------------------------------------------------
interface Event { type: string; [k: string]: unknown }

interface RunResult {
  events: Event[]
  diagPath: string
  /** XDG_RUNTIME_DIR used for this run — read the daemon handle from here for cleanup. */
  xdgRuntimeDir: string
}

// Every run's spawned daemon (auto-started by the extension, detached + unref'd
// so it survives this test's own subprocess exit) is killed in afterEach —
// otherwise every single test run in this file leaks a real, permanently
// running `web-spider serve` process.
const runtimeDirsToClean: string[] = []
afterEach(() => {
  for (const xdgRuntimeDir of runtimeDirsToClean.splice(0)) {
    const paths = resolveWebSpiderPaths({ env: { XDG_RUNTIME_DIR: xdgRuntimeDir } })
    const handle = readDaemonHandle(paths)
    if (handle) {
      try { process.kill(handle.pid, "SIGTERM") } catch { /* already gone */ }
    }
  }
})

function runCli(opts: {
  tool?: string
  /** Single invocation. Mutually exclusive with paramsList. */
  params?: Record<string, unknown>
  /** Multiple sequential invocations in the same process — same extension
   *  instance, same cache object. Use for cache round-trip tests. */
  paramsList?: Record<string, unknown>[]
  env?: Record<string, string>
  timeoutMs?: number
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    mkdirSync(CACHE_DIR, { recursive: true })
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Unique diag path — lets tests read diagnostics.
    const diagPath  = `${CACHE_DIR}/diag-${tag}.log`
    // Isolated XDG roots (+ HOME + WEB_SPIDER_CACHE_PATH) per run — without
    // ALL of these, the extension's daemon auto-start uses the operator's
    // real ~/.local/share, ~/.local/state, $XDG_RUNTIME_DIR, and (for the
    // one-time legacy-cache importer, which falls back to the real home
    // directory when WEB_SPIDER_CACHE_PATH is unset) the operator's real
    // ~/.cache/web-spider/pages.json — every one of these verified happening
    // in practice, more than once, before this fix covered all of them.
    const xdgRoot = `${CACHE_DIR}/xdg-${tag}`
    const xdgDataHome = join(xdgRoot, "data")
    const xdgStateHome = join(xdgRoot, "state")
    const xdgRuntimeDir = join(xdgRoot, "run")
    runtimeDirsToClean.push(xdgRuntimeDir)

    const invocations = opts.paramsList ?? [opts.params ?? {}]

    const args = [
      "--extension", EXTENSION,
      "--tool",      opts.tool ?? "web_fetch",
      // Each element becomes a separate --params flag; mock-pi-cli.mjs
      // invokes the tool once per flag in the same process.
      ...invocations.flatMap(p => ["--params", JSON.stringify(p)]),
      "--env",       `WEB_SPIDER_DIAG_PATH=${diagPath}`,
      "--env",       `HOME=${xdgRoot}`,
      "--env",       `WEB_SPIDER_CACHE_PATH=${join(xdgRoot, "no-legacy-cache-here.json")}`,
      "--env",       `XDG_DATA_HOME=${xdgDataHome}`,
      "--env",       `XDG_STATE_HOME=${xdgStateHome}`,
      "--env",       `XDG_RUNTIME_DIR=${xdgRuntimeDir}`,
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ]

    const proc = spawn("node", [CLI, ...args], {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const lines: string[] = []
    const stderr: string[] = []

    proc.stdout.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)))
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()))

    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error(`mock-pi-cli timed out after ${opts.timeoutMs ?? 15000}ms`))
    }, opts.timeoutMs ?? 15000)

    proc.on("close", () => {
      clearTimeout(timer)
      try {
        resolve({ events: lines.map(l => JSON.parse(l) as Event), diagPath, xdgRuntimeDir })
      } catch (e) {
        reject(new Error(`failed to parse NDJSON: ${e}\nlines: ${lines.join("\n")}\nstderr: ${stderr.join("")}`))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: production jiti load (tryNative:true + alias)", () => {

  it("extension loads and tool is registered", async () => {
    const { events } = await runCli({
      params: { url: "https://example.com", format: "lean" },
      timeoutMs: 20000,
    })

    const start = events.find(e => e.type === "tool_execution_start")
    const end   = events.find(e => e.type === "tool_execution_end")

    expect(start).toBeDefined()
    expect(end).toBeDefined()

    const result = (end as { result: { content: { text: string }[] } }).result
    const text   = JSON.parse(result.content[0].text)

    expect(text).not.toHaveProperty("error")
    expect(text).toHaveProperty("title")
  }, 25000)

  it("Playwright error propagates through the native error event", async () => {
    const { events } = await runCli({
      params: { url: "https://example.com", enhanced: true },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,
    })

    const error = events.find(e => e.type === "tool_execution_error")
    expect(error).toBeDefined()
    expect((error as { error: string }).error).toMatch(/executable|launch|nonexistent/i)
  }, 25000)

  it("enhanced=true with missing binary emits an error immediately", async () => {
    const { events } = await runCli({
      params: { url: "https://example.com", enhanced: true },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,
    })

    expect(events.find(e => e.type === "tool_execution_error")).toBeDefined()
  }, 25000)

  it("process exits cleanly — does not hang", async () => {
    const { events } = await runCli({
      params: { url: "https://github.com/hyprwm/aquamarine/issues" },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,  // would hit this if the process hangs
    })

    const exit = events.find(e => e.type === "exit")
    expect(exit).toBeDefined()
  }, 25000)

  it("cache round-trip: second fetch hits in-memory cache — no Map errors", async () => {
    const { events } = await runCli({
      paramsList: [
        { url: "https://example.com", format: "lean" },
        { url: "https://example.com", format: "lean" },
      ],
      timeoutMs: 25000,
    })

    const ends = events.filter(e => e.type === "tool_execution_end")
    expect(ends).toHaveLength(2)

    for (const end of ends) {
      const text = JSON.parse((end as { result: { content: { text: string }[] } }).result.content[0].text)
      expect(text).not.toHaveProperty("error")
      expect(text).toHaveProperty("title")
    }

    const exit = events.find(e => e.type === "exit")
    expect(exit).toBeDefined()
    expect((exit as { code: number }).code).toBe(0)
  }, 30000)
})
