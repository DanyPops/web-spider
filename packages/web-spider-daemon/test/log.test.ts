/**
 * Regression coverage for a real bug: the periodic checkpoint/optimize
 * maintenance timers in daemon.ts used to swallow failures with an empty
 * catch block -- "best-effort maintenance", no logging at all -- so a
 * genuine failure (corrupted WAL, disk full) would vanish with zero signal
 * anywhere. Matches papyrus/test/log.test.ts's coverage of the identical
 * logEvent shape.
 */
import { describe, expect, it } from "bun:test";
import { logEvent } from "../src/log.ts";

describe("Web Spider daemon logging", () => {
	it("emits credential-free structured events with the right component", () => {
		const lines: string[] = [];
		const original = console.error;
		console.error = (line?: unknown) => { lines.push(String(line)); };
		try {
			logEvent("error", "checkpoint_failed", { message: "disk full" });
		} finally {
			console.error = original;
		}
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({ level: "error", component: "web-spider-daemon", event: "checkpoint_failed", message: "disk full" });
		expect(typeof event["timestamp"]).toBe("string");
		expect(lines[0]).not.toContain("token");
	});

	it("defaults fields to an empty object rather than throwing when omitted", () => {
		const original = console.error;
		let line = "";
		console.error = (l?: unknown) => { line = String(l); };
		try {
			expect(() => logEvent("info", "listening")).not.toThrow();
		} finally {
			console.error = original;
		}
		expect(JSON.parse(line)).toMatchObject({ level: "info", event: "listening" });
	});
});
