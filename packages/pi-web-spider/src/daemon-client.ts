/**
 * Authenticated Web Spider daemon client — ported from
 * @danypops/web-spider-daemon's client.ts/state.ts (the Bun-independent
 * subset: node:fs/os/path/crypto and global fetch only, no bun:sqlite).
 *
 * This is an intentional, acknowledged duplication rather than an npm
 * dependency on @danypops/web-spider-daemon's TypeScript source: that
 * package ships raw TS run only via a real `bun` invocation (its db.ts/
 * cli.ts import bun:sqlite), while this extension is loaded by Pi through
 * three different paths verified by this package's own test suite (native
 * ESM, jiti tryNative:false, jiti tryNative:true + Bun binary) — none of
 * which reliably transpile a *dependency's* raw TypeScript. Duplicating
 * this small, dependency-free client (~150 lines) avoids adding a new,
 * unverified cross-package loader interaction on top of that already
 * fragile history (see git log: "Map operation called on non-Map object").
 * connectOrStartWebSpiderClient() only needs @danypops/web-spider-daemon
 * installed as *files on disk* (to locate and spawn its cli.ts) — it never
 * imports that package's code.
 *
 * resolveWebSpiderPaths()/ensureAuthToken()/readDaemonHandle() below stay
 * duplicated from daemon-kit's own `paths` module rather than importing it,
 * for the same reason: daemon-kit ships `./paths` as raw TypeScript (only
 * `./pi-client` is precompiled specifically for jiti-loader safety), so
 * importing it here would reintroduce the exact loader risk this file's
 * connectWithPolicy()/createRetryingClient() adoption was meant to retire.
 */

import { spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connectWithPolicy, type SpawnPlatformOptions, spawnDetachedDaemon } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";

const LOOPBACK_HOST = "127.0.0.1";
const WEB_SPIDER_STATE_DIRECTORY = "web-spider";
const TOKEN_FILENAME = "auth-token";
const HANDLE_FILENAME = "daemon.json";
const DAEMON_START_TIMEOUT_MS = 5_000;
const DAEMON_START_POLL_INTERVAL_MS = 100;

export interface WebSpiderPaths {
	database: string;
	token: string;
	handle: string;
}

export interface DaemonHandle {
	host: typeof LOOPBACK_HOST;
	port: number;
	pid: number;
}

interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolveWebSpiderPaths(options: PathEnvironment = {}): WebSpiderPaths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
	const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
	const runtimeHome = env.XDG_RUNTIME_DIR ?? join("/run", "user", String(uid));
	return {
		database: join(dataHome, WEB_SPIDER_STATE_DIRECTORY, "web-spider.db"),
		token: join(stateHome, WEB_SPIDER_STATE_DIRECTORY, TOKEN_FILENAME),
		handle: join(runtimeHome, WEB_SPIDER_STATE_DIRECTORY, HANDLE_FILENAME),
	};
}

export function ensureAuthToken(paths: WebSpiderPaths): string {
	mkdirSync(dirname(paths.token), { recursive: true, mode: 0o700 });
	if (existsSync(paths.token)) {
		chmodSync(paths.token, 0o600);
		const token = readFileSync(paths.token, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid Web Spider authentication token");
		return token;
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
	return token;
}

export function readDaemonHandle(paths: WebSpiderPaths): DaemonHandle | null {
	try {
		const value = JSON.parse(readFileSync(paths.handle, "utf8")) as Partial<DaemonHandle>;
		if (
			value.host !== LOOPBACK_HOST ||
			!Number.isInteger(value.port) ||
			(value.port as number) < 1 ||
			(value.port as number) > 65_535 ||
			!Number.isInteger(value.pid)
		)
			return null;
		return value as DaemonHandle;
	} catch {
		return null;
	}
}

export type FetchTransport = (request: Request) => Promise<Response>;

export class WebSpiderClient {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly transport: FetchTransport = fetch,
	) {}

	async call<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
		const response = await this.transport(
			new Request(`${this.baseUrl}/api/v1/ops`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
				body: JSON.stringify({ op: operation, input }),
			}),
		);
		const body = (await response.json()) as { result?: T; error?: string };
		if (!response.ok) throw new Error(body.error ?? `Web Spider operation failed with HTTP ${response.status}`);
		return body.result as T;
	}

	async health(): Promise<{ ok: true; version: string }> {
		const response = await this.transport(
			new Request(`${this.baseUrl}/health`, {
				headers: { authorization: `Bearer ${this.token}` },
			}),
		);
		const body = (await response.json()) as { ok?: boolean; version?: string; error?: string };
		if (!response.ok || body.ok !== true || typeof body.version !== "string")
			throw new Error(body.error ?? "Web Spider health check failed");
		return { ok: true, version: body.version };
	}
}

export function connectWebSpiderClient(paths: WebSpiderPaths = resolveWebSpiderPaths()): WebSpiderClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Web Spider daemon is not running; install or start web-spider.service");
	const token = ensureAuthToken(paths);
	return new WebSpiderClient(`http://${handle.host}:${handle.port}`, token);
}

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
