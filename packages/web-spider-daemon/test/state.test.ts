import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureAuthToken,
	readDaemonHandle,
	removeDaemonHandle,
	resolveLegacyCachePath,
	resolveWebSpiderPaths,
	writeDaemonHandle,
} from "../src/state.ts";

function tempEnv() {
	const root = mkdtempSync(join(tmpdir(), "web-spider-state-"));
	return {
		root,
		paths: resolveWebSpiderPaths({
			env: { XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") },
			home: root,
			uid: 1000,
		}),
	};
}

describe("resolveWebSpiderPaths", () => {
	test("places each path under the correct XDG root", () => {
		const { paths } = tempEnv();
		expect(paths.database).toContain(join("data", "web-spider", "web-spider.db"));
		expect(paths.token).toContain(join("state", "web-spider", "auth-token"));
		expect(paths.handle).toContain(join("run", "web-spider", "daemon.json"));
		expect(paths.systemdUnit).toContain(join("config", "systemd", "user", "web-spider.service"));
	});

	test("falls back to home-relative defaults when XDG vars are unset", () => {
		const paths = resolveWebSpiderPaths({ env: {}, home: "/home/example", uid: 1000 });
		expect(paths.database).toBe("/home/example/.local/share/web-spider/web-spider.db");
		expect(paths.token).toBe("/home/example/.local/state/web-spider/auth-token");
		expect(paths.handle).toBe("/run/user/1000/web-spider/daemon.json");
	});
});

describe("ensureAuthToken", () => {
	test("creates a 64-char hex token on first call and returns the same token on subsequent calls", () => {
		const { root, paths } = tempEnv();
		try {
			const first = ensureAuthToken(paths);
			expect(first).toMatch(/^[a-f0-9]{64}$/);
			const second = ensureAuthToken(paths);
			expect(second).toBe(first);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("daemon handle round-trip", () => {
	test("writes and reads back a valid handle", () => {
		const { root, paths } = tempEnv();
		try {
			expect(readDaemonHandle(paths)).toBeNull();
			writeDaemonHandle(paths, { host: "127.0.0.1", port: 4321, pid: process.pid });
			const handle = readDaemonHandle(paths);
			expect(handle).toEqual({ host: "127.0.0.1", port: 4321, pid: process.pid });
			removeDaemonHandle(paths);
			expect(readDaemonHandle(paths)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a handle with an out-of-range port", () => {
		const { root, paths } = tempEnv();
		try {
			writeDaemonHandle(paths, { host: "127.0.0.1", port: 70_000 as unknown as number, pid: 1 });
			expect(readDaemonHandle(paths)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveLegacyCachePath", () => {
	test("defaults to ~/.cache/web-spider/pages.json — the pi-extension's historical default", () => {
		expect(resolveLegacyCachePath({ env: {}, home: "/home/example" })).toBe(join("/home/example", ".cache", "web-spider", "pages.json"));
	});

	test("honors WEB_SPIDER_CACHE_PATH when set, matching the pi-extension's existing override", () => {
		expect(resolveLegacyCachePath({ env: { WEB_SPIDER_CACHE_PATH: "/custom/pages.json" }, home: "/home/example" })).toBe("/custom/pages.json");
	});
});
