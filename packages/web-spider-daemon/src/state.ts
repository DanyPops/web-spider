/**
 * Process/storage layout and authenticated discovery — mirrors
 * jittor/src/state.ts exactly (XDG_DATA_HOME db, XDG_STATE_HOME token,
 * XDG_RUNTIME_DIR daemon handle, XDG_CONFIG_HOME systemd unit).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	DATABASE_FILENAME,
	HANDLE_FILENAME,
	LEGACY_CACHE_DEFAULT_RELATIVE_PATH,
	LOOPBACK_HOST,
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

export interface DaemonHandle {
	host: typeof LOOPBACK_HOST;
	port: number;
	pid: number;
}

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export function resolveWebSpiderPaths(options: PathEnvironment = {}): WebSpiderPaths {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const dataHome = env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
	const stateHome = env["XDG_STATE_HOME"] ?? join(home, ".local", "state");
	const runtimeHome = env["XDG_RUNTIME_DIR"] ?? join("/run", "user", String(uid));
	const configHome = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
	return {
		database: join(dataHome, WEB_SPIDER_STATE_DIRECTORY, DATABASE_FILENAME),
		token: join(stateHome, WEB_SPIDER_STATE_DIRECTORY, TOKEN_FILENAME),
		handle: join(runtimeHome, WEB_SPIDER_STATE_DIRECTORY, HANDLE_FILENAME),
		systemdUnit: join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME),
	};
}

export function ensureAuthToken(paths: WebSpiderPaths = resolveWebSpiderPaths()): string {
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

export function writeDaemonHandle(paths: WebSpiderPaths, handle: DaemonHandle): void {
	mkdirSync(dirname(paths.handle), { recursive: true, mode: 0o700 });
	const temporary = `${paths.handle}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(handle)}\n`, { mode: 0o600 });
	renameSync(temporary, paths.handle);
}

export function readDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): DaemonHandle | null {
	try {
		const value = JSON.parse(readFileSync(paths.handle, "utf8")) as Partial<DaemonHandle>;
		if (value.host !== LOOPBACK_HOST || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65_535 || !Number.isInteger(value.pid)) return null;
		return value as DaemonHandle;
	} catch {
		return null;
	}
}

export function removeDaemonHandle(paths: WebSpiderPaths = resolveWebSpiderPaths()): void {
	rmSync(paths.handle, { force: true });
}

/**
 * Path to the pre-daemon JSON DiskCache, for the one-time legacy import.
 * Respects WEB_SPIDER_CACHE_PATH (the same override the pi-extension has
 * used to date) so an existing custom cache location is still found.
 */
export function resolveLegacyCachePath(options: PathEnvironment = {}): string {
	const env = options.env ?? process.env;
	if (env["WEB_SPIDER_CACHE_PATH"]) return env["WEB_SPIDER_CACHE_PATH"];
	const home = options.home ?? homedir();
	return join(home, ...LEGACY_CACHE_DEFAULT_RELATIVE_PATH);
}
