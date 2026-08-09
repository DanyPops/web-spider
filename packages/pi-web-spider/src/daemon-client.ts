/**
 * Pi-specific daemon auto-start composition. Shared client, authentication,
 * XDG path, token, and handle behavior comes from the daemon's precompiled,
 * Bun-independent Facade subpaths; only process spawn/poll policy stays here.
 */

import { spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { connectWithPolicy, type SpawnPlatformOptions, spawnDetachedDaemon } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { connectWebSpiderClient, WebSpiderClient } from "@danypops/web-spider-daemon/client";
import { ensureAuthToken, readDaemonHandle, resolveWebSpiderPaths, type WebSpiderPaths } from "@danypops/web-spider-daemon/state";

export type { FetchTransport } from "@danypops/web-spider-daemon/client";
export type { DaemonHandle, PathEnvironment, WebSpiderPaths } from "@danypops/web-spider-daemon/state";
export { connectWebSpiderClient, ensureAuthToken, readDaemonHandle, resolveWebSpiderPaths, WebSpiderClient };

const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_INTERVAL_MS = 100;

/** Resolves the installed @danypops/web-spider-daemon package's cli.ts on disk — no code import, path only. */
function resolveDaemonCliPath(): string {
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("@danypops/web-spider-daemon/package.json");
	return join(dirname(packageJsonPath), "src", "cli.ts");
}

/**
 * Connects to the Web Spider daemon, transparently starting it first if it
 * is not already running — the tool must "just work" without a manual
 * `web-spider service install` step for a fresh install, matching today's
 * zero-config DiskCache behavior. Falls back to a clear actionable error if
 * auto-start fails (e.g. bun is not on PATH, or the package files are
 * missing), pointing at manual installation instead of failing silently.
 * Delegates the actual autoStart-vs-fail-closed policy and spawn/poll loop
 * to @danypops/vehicle-client's connectWithPolicy() -- the same shared policy
 * lector/papyrus/pi-packed each independently forked (they fail closed;
 * this extension is the one that opts into autoStart, explicitly).
 */
export interface ConnectOrStartOptions {
	/**
	 * Environment passed to the spawned daemon process. Defaults to the
	 * current process.env, so a transparently auto-started daemon sees the
	 * same XDG/API-key environment the extension itself sees — production
	 * behavior. Tests override this (full env plus isolated XDG_* overrides)
	 * so the spawned child and the parent's own resolveWebSpiderPaths() agree
	 * on where the handle file lives.
	 */
	env?: Record<string, string | undefined>;
}

export async function connectOrStartWebSpiderClient(
	paths: WebSpiderPaths = resolveWebSpiderPaths(),
	options: ConnectOrStartOptions = {},
): Promise<WebSpiderClient> {
	return connectWithPolicy({
		readHandle: () => readDaemonHandle(paths),
		buildClient: (handle) => new WebSpiderClient(`http://${handle.host}:${handle.port}`, ensureAuthToken(paths)),
		autoStart: true,
		spawn: () => spawnWebSpiderDaemon(options.env),
		fallbackMessage: "Web Spider daemon failed to start automatically; run `web-spider service install` or `web-spider serve` manually.",
		startTimeoutMs: DAEMON_START_TIMEOUT_MS,
		pollIntervalMs: DAEMON_START_POLL_INTERVAL_MS,
	});
}

/**
 * Same auto-spawn policy as connectOrStartWebSpiderClient (same daemon,
 * same handle file) but builds a RemoteVehicleClient against the daemon's
 * /vehicle/* routes instead of a WebSpiderClient against /api/v1/ops --
 * used by whichever tool operations have migrated onto the real Vehicle
 * protocol so far (see web-spider-daemon's category-vehicle.ts).
 */
export async function connectOrStartWebSpiderVehicleClient(
	paths: WebSpiderPaths = resolveWebSpiderPaths(),
	options: ConnectOrStartOptions = {},
): Promise<RemoteVehicleClient> {
	return connectWithPolicy({
		readHandle: () => readDaemonHandle(paths),
		buildClient: (handle) => new RemoteVehicleClient({ baseUrl: `http://${handle.host}:${handle.port}`, token: ensureAuthToken(paths) }),
		autoStart: true,
		spawn: () => spawnWebSpiderDaemon(options.env),
		fallbackMessage: "Web Spider daemon failed to start automatically; run `web-spider service install` or `web-spider serve` manually.",
		startTimeoutMs: DAEMON_START_TIMEOUT_MS,
		pollIntervalMs: DAEMON_START_POLL_INTERVAL_MS,
	});
}

/**
 * Shared by both connect-or-start functions above -- the exact same spawn
 * behavior (resolve the installed daemon package's cli.ts, spawn it
 * detached via spawnDetachedDaemon), only the resulting client type
 * differs between the two callers.
 */
/**
 * spawnDetachedDaemon's injected spawn() callback, factored out for a direct unit test.
 *
 * A spawn() failure (missing binPath, bad permissions, wrong interpreter) surfaces
 * asynchronously as an "error" event on the ChildProcess -- with no listener, Node treats it
 * as an uncaught exception and kills the whole host process, not just this one connect
 * attempt (see @danypops/vehicle-client's spawn-error-uncaught-crash.test.ts, and papyrus's
 * own client.ts, which hit exactly this in production). The listener below turns that into
 * an ordinary logged failure instead: the handle file simply never appears, and
 * connectWithPolicy's own poll-then-timeout already reports that as its usual, catchable
 * fallbackMessage error.
 */
export function spawnWebSpiderDaemonProcess(command: string, args: string[], spawnOptions: SpawnPlatformOptions): void {
	const child = spawnProcess(command, args, spawnOptions);
	child.on("error", (error) => {
		// biome-ignore lint/suspicious/noConsole: the only diagnostic surface for an otherwise-silent auto-spawn failure.
		console.error(`Web Spider daemon auto-spawn failed: ${error instanceof Error ? error.message : String(error)}`);
	});
	child.unref();
}

function spawnWebSpiderDaemon(env: Record<string, string | undefined> | undefined): void {
	let cliPath: string;
	try {
		cliPath = resolveDaemonCliPath();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Web Spider daemon package not found (${message}); run \`packed install npm:@danypops/web-spider-daemon\` then \`web-spider service install\`.`,
		);
	}
	// spawnDetachedDaemon centralizes platform-correct spawn options (Windows
	// console-hiding, DAEMON_KIT_LAUNCH_PROVENANCE="auto-spawn" for daemon-kit's
	// idle-shutdown default) that this file's own hand-rolled spawn call
	// didn't have -- the actual node:child_process.spawn() call still
	// happens here, daemon-kit only shapes its options.
	spawnDetachedDaemon({
		binPath: cliPath,
		args: ["serve"],
		env: env ?? process.env,
		spawn: spawnWebSpiderDaemonProcess,
	});
}
