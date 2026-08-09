import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

const CLIENT_SUBPATH = "@danypops/web-spider-daemon/client";
const STATE_SUBPATH = "@danypops/web-spider-daemon/state";

function assertFacade(client: Record<string, unknown>, state: Record<string, unknown>): void {
	expect(typeof client.WebSpiderClient).toBe("function");
	expect(typeof client.connectWebSpiderClient).toBe("function");
	expect(typeof state.resolveWebSpiderPaths).toBe("function");
	expect(typeof state.ensureAuthToken).toBe("function");
	expect(typeof state.readDaemonHandle).toBe("function");
}

describe("@danypops/web-spider-daemon Bun-independent facade subpaths", () => {
	it("load under native Node ESM", () => {
		const script = `
			const client = await import(${JSON.stringify(CLIENT_SUBPATH)});
			const state = await import(${JSON.stringify(STATE_SUBPATH)});
			if (typeof client.WebSpiderClient !== "function" || typeof client.connectWebSpiderClient !== "function") process.exit(2);
			if (typeof state.resolveWebSpiderPaths !== "function" || typeof state.ensureAuthToken !== "function" || typeof state.readDaemonHandle !== "function") process.exit(3);
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
	});

	for (const tryNative of [false, true]) {
		it(`loads under jiti tryNative:${tryNative}`, async () => {
			const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative });
			const client = (await jiti.import(CLIENT_SUBPATH)) as Record<string, unknown>;
			const state = (await jiti.import(STATE_SUBPATH)) as Record<string, unknown>;
			assertFacade(client, state);
		});
	}
});
