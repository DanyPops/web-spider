/**
 * Process/storage layout and authenticated discovery. Delegates to
 * @danypops/daemon-kit's generic paths module (XDG_DATA_HOME db,
 * XDG_STATE_HOME token, XDG_RUNTIME_DIR daemon handle, XDG_CONFIG_HOME
 * systemd unit) -- this file used to duplicate that logic byte-for-byte
 * with jittor's/papyrus's own copies. Kept as a thin WebSpiderPaths-object
 * wrapper so every existing call site (daemon.ts, client.ts, cli.ts,
 * tests) is unaffected by the migration.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ensureAuthToken as daemonKitEnsureAuthToken,
	readDaemonHandle as daemonKitReadDaemonHandle,
	removeDaemonHandle as daemonKitRemoveDaemonHandle,
	resolveDaemonPaths,
	writeDaemonHandle as daemonKitWriteDaemonHandle,
	type DaemonHandle as DaemonKitHandle,
} from "@danypops/daemon-kit/paths";
import {
	DATABASE_FILENAME,
	HANDLE_FILENAME,
	LEGACY_CACHE_DEFAULT_RELATIVE_PATH,
	SYSTEMD_UNIT_NAME,
	TOKEN_FILENAME,
	WEB_SPIDER_STATE_DIRECTORY,
} from "./constants.ts";

export interface WebSpiderPaths {
	database: string;
	token: string;
	handle: string;
	systemdUnit: string;
}

// daemon-kit's DaemonHandle is structurally { host: "127.0.0.1"; port; pid },
// identical to what this module has always exposed -- re-exported under the
// existing name so no consumer needs to change its import.
export type DaemonHandle = DaemonKitHandle;

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolveWebSpiderPaths(options: PathEnvironment = {}): WebSpiderPaths {
	return resolveDaemonPaths(
		{
			stateDirectoryName: WEB_SPIDER_STATE_DIRECTORY,
			databaseFilename: DATABASE_FILENAME,
			tokenFilename: TOKEN_FILENAME,
			handleFilename: HANDLE_FILENAME,
			systemdUnitName: SYSTEMD_UNIT_NAME,
		},
		options,
	);
}

export function ensureAuthToken(paths: WebSpiderPaths = resolveWebSpiderPaths()): string {
	return daemonKitEnsureAuthToken(paths.token, "Web Spider");
}

export function writeDaemonHandle(paths: WebSpiderPaths, handle: DaemonHandle): void {
	daemonKitWriteDaemonHandle(paths.handle, handle);
}

export function readDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): DaemonHandle | null {
	return daemonKitReadDaemonHandle(paths.handle);
}

export function removeDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): void {
	daemonKitRemoveDaemonHandle(paths.handle);
}

/**
 * Path to the pre-daemon JSON DiskCache, for the one-time legacy import.
 * Respects WEB_SPIDER_CACHE_PATH (the same override the pi-extension has
 * used to date) so an existing custom cache location is still found.
 * Web-Spider-specific, not a generic daemon concern -- stays here rather
 * than moving into daemon-kit.
 */
export function resolveLegacyCachePath(options: PathEnvironment = {}): string {
	const env = options.env ?? process.env;
	if (env["WEB_SPIDER_CACHE_PATH"]) return env["WEB_SPIDER_CACHE_PATH"];
	const home = options.home ?? homedir();
	return join(home, ...LEGACY_CACHE_DEFAULT_RELATIVE_PATH);
}
