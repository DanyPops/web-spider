/**
 * Process/storage layout and authenticated discovery. Delegates to
 * @danypops/vehicle-server's generic paths module (XDG_DATA_HOME db,
 * XDG_STATE_HOME token, XDG_RUNTIME_DIR daemon handle, XDG_CONFIG_HOME
 * systemd unit) -- this file used to duplicate that logic byte-for-byte
 * with jittor's/papyrus's own copies. Kept as a thin WebSpiderPaths-object
 * wrapper so every existing call site (daemon.ts, client.ts, cli.ts,
 * tests) is unaffected by the migration.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type DaemonHandle as DaemonKitHandle,
	resolveDaemonPaths,
	ensureAuthToken as vehicleEnsureAuthToken,
	readDaemonHandle as vehicleReadDaemonHandle,
	removeDaemonHandle as vehicleRemoveDaemonHandle,
	writeDaemonHandle as vehicleWriteDaemonHandle,
} from "@danypops/vehicle-server/paths";
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

// vehicle-server's DaemonHandle is structurally { host: "127.0.0.1"; port; pid },
// identical to what this module has always exposed -- re-exported under the
// existing name so no consumer needs to change its import.
export type DaemonHandle = DaemonKitHandle;

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolveWebSpiderPaths(options: PathEnvironment = {}): WebSpiderPaths {
	// vehicle-server renamed DaemonPaths.systemdUnit to the platform-neutral
	// serviceDescriptor -- mapped back to this module's own stable field name
	// here so no existing consumer (cli.ts) needs to change its own field access.
	const resolved = resolveDaemonPaths(
		{
			stateDirectoryName: WEB_SPIDER_STATE_DIRECTORY,
			databaseFilename: DATABASE_FILENAME,
			tokenFilename: TOKEN_FILENAME,
			handleFilename: HANDLE_FILENAME,
			systemdUnitName: SYSTEMD_UNIT_NAME,
		},
		options,
	);
	return { database: resolved.database, token: resolved.token, handle: resolved.handle, systemdUnit: resolved.serviceDescriptor };
}

export function ensureAuthToken(paths: WebSpiderPaths = resolveWebSpiderPaths()): string {
	return vehicleEnsureAuthToken(paths.token, "Web Spider");
}

export function writeDaemonHandle(paths: WebSpiderPaths, handle: DaemonHandle): void {
	vehicleWriteDaemonHandle(paths.handle, handle);
}

export function readDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): DaemonHandle | null {
	return vehicleReadDaemonHandle(paths.handle);
}

export function removeDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): void {
	vehicleRemoveDaemonHandle(paths.handle);
}

/**
 * Path to the pre-daemon JSON DiskCache, for the one-time legacy import.
 * Respects WEB_SPIDER_CACHE_PATH (the same override the pi-extension has
 * used to date) so an existing custom cache location is still found.
 * Web-Spider-specific, not a generic daemon concern -- stays here rather
 * than moving into vehicle-server.
 */
export function resolveLegacyCachePath(options: PathEnvironment = {}): string {
	const env = options.env ?? process.env;
	if (env.WEB_SPIDER_CACHE_PATH) return env.WEB_SPIDER_CACHE_PATH;
	const home = options.home ?? homedir();
	return join(home, ...LEGACY_CACHE_DEFAULT_RELATIVE_PATH);
}
