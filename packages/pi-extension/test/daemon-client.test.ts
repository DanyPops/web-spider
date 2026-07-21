/**
 * daemon-client.ts is a deliberate duplication of @danypops/web-spider-daemon's
 * client.ts/state.ts (see daemon-client.ts's own doc comment for why) — this
 * suite mirrors that package's state.test.ts/daemon.test.ts coverage so the
 * duplicate stays correct independently.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  connectOrStartWebSpiderClient,
  connectWebSpiderClient,
  ensureAuthToken,
  readDaemonHandle,
  resolveWebSpiderPaths,
  WebSpiderClient,
  type WebSpiderPaths,
} from "../src/daemon-client.js"

function tempPaths(): { root: string; paths: WebSpiderPaths; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "pi-web-spider-daemon-client-"))
  const env = {
    ...(process.env as Record<string, string>),
    // HOME and WEB_SPIDER_CACHE_PATH matter too, not just the three XDG_*
    // vars: the daemon's one-time legacy-cache importer falls back to the
    // real home directory when WEB_SPIDER_CACHE_PATH is unset — verified
    // happening in practice (twice) without this, importing (and renaming)
    // the operator's real ~/.cache/web-spider/pages.json.
    HOME: root,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache-here.json"),
  }
  return {
    root,
    // resolveWebSpiderPaths() must see the *same* XDG overrides the spawned
    // child's env carries, or the parent polls a handle path the child never
    // writes to — a real bug this test setup previously had.
    paths: resolveWebSpiderPaths({ env, home: root, uid: 1000 }),
    env,
  }
}

describe("resolveWebSpiderPaths", () => {
  it("places each path under the correct XDG root", () => {
    const { paths } = tempPaths()
    expect(paths.database).toContain(join("data", "web-spider", "web-spider.db"))
    expect(paths.token).toContain(join("state", "web-spider", "auth-token"))
    expect(paths.handle).toContain(join("run", "web-spider", "daemon.json"))
  })
})

describe("ensureAuthToken", () => {
  it("creates a 64-char hex token and reuses it on subsequent calls", () => {
    const { root, paths } = tempPaths()
    try {
      const first = ensureAuthToken(paths)
      expect(first).toMatch(/^[a-f0-9]{64}$/)
      expect(ensureAuthToken(paths)).toBe(first)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("readDaemonHandle", () => {
  it("returns null when no handle file exists", () => {
    const { root, paths } = tempPaths()
    try {
      expect(readDaemonHandle(paths)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("WebSpiderClient", () => {
  it("calls the operation endpoint with a bearer token and returns the result", async () => {
    let capturedRequest: Request | undefined
    const client = new WebSpiderClient("http://127.0.0.1:1", "test-token", async (request) => {
      capturedRequest = request
      return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 })
    })
    const result = await client.call("cache.list", {})
    expect(result).toEqual({ ok: true })
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer test-token")
    expect(capturedRequest?.url).toBe("http://127.0.0.1:1/api/v1/ops")
  })

  it("throws the daemon's error message on a non-ok response", async () => {
    const client = new WebSpiderClient("http://127.0.0.1:1", "test-token", async () =>
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 }))
    await expect(client.call("fetch", { url: "https://x.test" })).rejects.toThrow("bad request")
  })

  it("health() validates ok:true and a string version", async () => {
    const client = new WebSpiderClient("http://127.0.0.1:1", "test-token", async () =>
      new Response(JSON.stringify({ ok: true, version: "0.1.0" }), { status: 200 }))
    await expect(client.health()).resolves.toEqual({ ok: true, version: "0.1.0" })
  })
})

describe("connectWebSpiderClient", () => {
  it("fails closed with an actionable message when no daemon is running", () => {
    const { root, paths } = tempPaths()
    try {
      expect(() => connectWebSpiderClient(paths)).toThrow(/daemon is not running/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("connectOrStartWebSpiderClient — real subprocess integration", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it("auto-starts the real daemon when none is running, then connects", async () => {
    const { root, paths, env } = tempPaths()
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    const client = await connectOrStartWebSpiderClient(paths, { env })
    const health = await client.health()
    expect(health.ok).toBe(true)

    const listing = await client.call("cache.list", {})
    expect(listing).toEqual({ total: 0, filtered: 0, offset: 0, limit: 20, pages: [] })

    // Best-effort shutdown of the daemon we started, so the test doesn't leak a process.
    const handle = readDaemonHandle(paths)
    if (handle) {
      try { process.kill(handle.pid, "SIGTERM") } catch { /* already gone */ }
    }
  }, 15_000)

  it("reuses an already-running daemon instead of starting a second one", async () => {
    const { root, paths, env } = tempPaths()
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))

    const first = await connectOrStartWebSpiderClient(paths, { env })
    await first.health()
    const handleAfterFirst = readDaemonHandle(paths)

    const second = await connectOrStartWebSpiderClient(paths, { env })
    await second.health()
    const handleAfterSecond = readDaemonHandle(paths)

    expect(handleAfterSecond).toEqual(handleAfterFirst) // same daemon, not a second one started

    if (handleAfterFirst) {
      try { process.kill(handleAfterFirst.pid, "SIGTERM") } catch { /* already gone */ }
    }
  }, 15_000)
})
