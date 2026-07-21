/**
 * Shared per-test daemon isolation. Every test that boots the extension can
 * reach getClient() → connectOrStartWebSpiderClient(), which auto-starts a
 * real `web-spider serve` subprocess using ambient XDG_DATA_HOME/
 * XDG_STATE_HOME/XDG_RUNTIME_DIR when no override is given — verified in
 * practice: running this suite without isolation left four real daemon
 * processes running and real state under the operator's actual
 * ~/.local/share/web-spider, ~/.local/state/web-spider, and
 * $XDG_RUNTIME_DIR/web-spider (cleaned up once, by hand, when discovered).
 *
 * Every createExtensionHarness() call in this package's tests must pass
 * `env: isolatedDaemonEnv().env` and call `.cleanup()` in an after hook.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDaemonHandle, resolveWebSpiderPaths, type WebSpiderPaths } from "../src/daemon-client.js"

export interface IsolatedDaemonEnv {
  root: string
  env: Record<string, string>
  paths: WebSpiderPaths
  /** Kills any daemon this test started and removes the temp root. Call in afterAll/afterEach. */
  cleanup(): void
}

export function isolatedDaemonEnv(prefix = "pi-web-spider-test-"): IsolatedDaemonEnv {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // HOME and WEB_SPIDER_CACHE_PATH matter too, not just the three XDG_* vars:
    // the daemon's one-time legacy-cache importer (resolveLegacyCachePath())
    // falls back to the real home directory when WEB_SPIDER_CACHE_PATH is unset
    // — verified happening in practice, twice, importing (and renaming) the
    // operator's real ~/.cache/web-spider/pages.json into an "isolated" daemon
    // that only isolated the three XDG vars.
    HOME: root,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
    WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache-here.json"),
  }
  const paths = resolveWebSpiderPaths({ env, home: root, uid: 1000 })
  return {
    root,
    env,
    paths,
    cleanup() {
      const handle = readDaemonHandle(paths)
      if (handle) {
        try { process.kill(handle.pid, "SIGTERM") } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}
