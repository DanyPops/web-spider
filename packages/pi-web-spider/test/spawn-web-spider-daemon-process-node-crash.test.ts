/**
 * spawnWebSpiderDaemonProcess (src/daemon-client.ts) is Node-specific defense: a spawn()
 * failure surfaces asynchronously as an unlistened "error" event only under real Node, not
 * Bun (Bun's own spawn() throws synchronously at the call site instead -- see
 * @danypops/vehicle-client's spawn-error-uncaught-crash.test.ts for that comparison, and
 * papyrus's client.ts, which hit this exact crash in production). This suite runs under
 * Vitest on real Node, so the interesting part isn't "run under Node" (already true here) --
 * it's building the real daemon-client.ts (a real dependency graph, real npm imports) into a
 * single Node-runnable file first, rather than a hand-copied duplicate of its body that could
 * silently drift from the shipped code.
 *
 * Shells out to the real `bun build` CLI rather than the Bun.build() API -- this test file
 * itself runs under Vitest on plain Node (no global Bun here), but `bun` as an external
 * command is still on PATH.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const BUILD_ROOT = join(import.meta.dirname, "..", ".node-crash-test-build");

afterAll(() => rmSync(BUILD_ROOT, { recursive: true, force: true }));

async function buildDaemonClientForNode(outDir: string): Promise<string> {
	await execFileAsync("bun", [
		"build",
		join(import.meta.dirname, "..", "src", "daemon-client.ts"),
		"--target=node",
		"--external=@danypops/vehicle-client/daemon-client",
		"--external=@danypops/vehicle-client/http",
		"--outdir",
		outDir,
	]);
	return join(outDir, "daemon-client.js");
}

function runUnderNode(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn("node", [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

describe("spawnWebSpiderDaemonProcess under real Node -- the same class of incident papyrus hit in production", () => {
	it("a missing binPath is logged and swallowed, never crashes the host process", async () => {
		mkdirSync(BUILD_ROOT, { recursive: true });
		const dir = mkdtempSync(join(BUILD_ROOT, "run-"));
		const clientPath = await buildDaemonClientForNode(dir);

		const scriptPath = join(dir, "run.mjs");
		writeFileSync(
			scriptPath,
			`
				import { spawnWebSpiderDaemonProcess } from ${JSON.stringify(clientPath)};
				spawnWebSpiderDaemonProcess("/definitely/does/not/exist/cli.ts", ["serve"], { detached: true, stdio: "ignore" });
				setTimeout(() => console.log("REACHED_END_WITHOUT_CRASHING"), 300);
				`,
		);

		const result = await runUnderNode(scriptPath);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("REACHED_END_WITHOUT_CRASHING");
		expect(result.stderr).toContain("Web Spider daemon auto-spawn failed: spawn /definitely/does/not/exist/cli.ts ENOENT");
		expect(result.stderr).not.toContain("Uncaught");
	}, 15_000);
});
