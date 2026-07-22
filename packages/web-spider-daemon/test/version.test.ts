/**
 * Regression/parity coverage for the daemon-kit migration: VERSION must
 * keep reading the daemon's own real package.json version (the bug this
 * session's earlier fix addressed -- a stale hardcoded "0.1.0") after
 * switching from a hand-rolled implementation to
 * @danypops/daemon-kit's readPackageVersion.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.ts";

describe("VERSION (via @danypops/daemon-kit's readPackageVersion)", () => {
	it("matches the daemon's real package.json version exactly", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(VERSION).toBe(manifest.version);
	});

	it("is a valid, non-stale semver string", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
		expect(VERSION).not.toBe("0.1.0");
	});
});
