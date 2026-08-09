/**
 * spawnWebSpiderDaemonProcess (src/daemon-client.ts) is handed the daemon's real
 * cli.ts path -- which has shebang `#!/usr/bin/env bun` -- as the spawn `command`.
 * POSIX kernels honor the shebang via execve; Windows has no shebang handling at
 * all, so node:child_process.spawn() returns EFTYPE for a `.ts` path there,
 * silently breaking every auto-started daemon connection on Windows (originally
 * reported and verified end-to-end on real Windows 11 in
 * https://github.com/DanyPops/web-spider/pull/7).
 *
 * Fix: on win32, route the spawn through `bun` explicitly -- the daemon
 * package's own scripts already run `bun src/cli.ts serve`, so `bun` is always
 * the right interpreter regardless of platform.
 */
import { spawn as spawnProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const { spawnWebSpiderDaemonProcess } = await import("../src/daemon-client.js");

describe("spawnWebSpiderDaemonProcess — Windows shebang/EFTYPE workaround", () => {
	it("routes the spawn through bun on win32, passing the original binPath as bun's first argument", () => {
		spawnWebSpiderDaemonProcess("/path/to/cli.ts", ["serve"], { detached: true, stdio: "ignore" }, "win32");
		expect(spawnProcess).toHaveBeenCalledWith("bun", ["/path/to/cli.ts", "serve"], { detached: true, stdio: "ignore" });
	});

	it("keeps the POSIX behavior unchanged — the binPath is spawned directly as the command", () => {
		spawnWebSpiderDaemonProcess("/path/to/cli.ts", ["serve"], { detached: true, stdio: "ignore" }, "linux");
		expect(spawnProcess).toHaveBeenCalledWith("/path/to/cli.ts", ["serve"], { detached: true, stdio: "ignore" });
	});

	it("defaults the platform to the real host platform when none is given", () => {
		spawnWebSpiderDaemonProcess("/path/to/cli.ts", ["serve"], { detached: true, stdio: "ignore" });
		const expectFn = process.platform === "win32" ? ["bun", ["/path/to/cli.ts", "serve"]] : ["/path/to/cli.ts", ["serve"]];
		expect(spawnProcess).toHaveBeenCalledWith(expectFn[0], expectFn[1], { detached: true, stdio: "ignore" });
	});
});
