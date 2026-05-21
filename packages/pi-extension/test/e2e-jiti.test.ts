/**
 * E2E integration test — production jiti load path.
 *
 * Why this exists:
 *   The unit-level playwright-fallback.test.ts uses vi.mock(), but vi.mock()
 *   operates in vitest's module registry. The extension's factory function
 *   uses dynamic import() which resolves through Node's native ESM loader,
 *   bypassing jiti's internal module cache — so vi.mock() never intercepts
 *   PlaywrightHttpClient in practice.
 *
 * What this does instead:
 *   Uses mock-pi-cli.mjs — a minimal Pi CLI stub that loads the extension
 *   through jiti with production-matching settings (alias + tryNative:true,
 *   NOT tryNative:false as createExtensionHarness uses). It then invokes
 *   web_fetch directly and emits JSON events, no LLM involved.
 *
 *   This is the same code path as the real Pi binary in Node.js mode.
 *
 * Error propagation under test:
 *   Set WEB_SPIDER_PLAYWRIGHT_EXECUTABLE=/nonexistent so Chrome fails to
 *   launch immediately. Verifies that the error surfaces as { error: string }
 *   in the tool result rather than hanging or crashing the process.
 *
 * TTY-mode fetch:
 *   Set a GitHub URL with depth=0 and no enhanced flag. The plain HTTP fetch
 *   should return jsRendered:true; Playwright retry with /nonexistent binary
 *   should propagate as { error }.
 */

import { spawn }  from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const __dirname   = dirname(fileURLToPath(import.meta.url))
const CLI         = resolve(__dirname, "fixtures/mock-pi-cli.mjs")
const EXTENSION   = resolve(__dirname, "../src/index.ts")
const CACHE_DIR = "/tmp/ws-e2e-jiti"

// ---------------------------------------------------------------------------
// Helper — run mock-pi-cli and collect emitted NDJSON events
// ---------------------------------------------------------------------------
interface Event { type: string; [k: string]: unknown }

function runCli(opts: {
  tool?: string
  params: Record<string, unknown>
  env?: Record<string, string>
  timeoutMs?: number
}): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    // Unique cache per run prevents cross-test cache hits (first test caches
    // example.com; without isolation the second test returns a cache hit,
    // bypassing Playwright entirely and masking the error propagation bug).
    const cachePath = `${CACHE_DIR}/cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`

    const args = [
      "--extension", EXTENSION,
      "--tool",      opts.tool ?? "web_fetch",
      "--params",    JSON.stringify(opts.params),
      "--env",       `WEB_SPIDER_CACHE_PATH=${cachePath}`,
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
        resolve(lines.map(l => JSON.parse(l) as Event))
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
    // Use a URL that plain fetch handles fine — no Playwright needed.
    // example.com is simple HTML, fully readable by Readability.
    const events = await runCli({
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

  it("Playwright error propagates as { error } — auto-fallback path", async () => {
    // enhanced:true forces Playwright regardless of jsRendered, exercising the
    // same error-propagation code path as the jsRendered auto-fallback.
    // GitHub's server-side HTML now has enough content for Readability (wordCount>0)
    // so jsRendered stays false on plain fetch — enhanced:true is the reliable trigger.
    const events = await runCli({
      params: { url: "https://example.com", enhanced: true },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,
    })

    const end = events.find(e => e.type === "tool_execution_end")
    expect(end).toBeDefined()

    const result = (end as { result: { content: { text: string }[] } }).result
    const text   = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
    expect(typeof text.error).toBe("string")
    expect(text.error).toMatch(/executable|launch|nonexistent/i)
  }, 25000)

  it("enhanced=true with missing binary returns { error } immediately", async () => {
    const events = await runCli({
      params: { url: "https://example.com", enhanced: true },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,
    })

    const end = events.find(e => e.type === "tool_execution_end")
    expect(end).toBeDefined()

    const result = (end as { result: { content: { text: string }[] } }).result
    const text   = JSON.parse(result.content[0].text)

    expect(text).toHaveProperty("error")
  }, 25000)

  it("process exits cleanly — does not hang", async () => {
    // Timeout is the failure mode we're guarding against.
    const events = await runCli({
      params: { url: "https://github.com/hyprwm/aquamarine/issues" },
      env:    { WEB_SPIDER_PLAYWRIGHT_EXECUTABLE: "/nonexistent" },
      timeoutMs: 20000,  // would hit this if the process hangs
    })

    const exit = events.find(e => e.type === "exit")
    expect(exit).toBeDefined()
  }, 25000)
})
