/**
 * Regression coverage for a real bug: the periodic checkpoint/optimize
 * maintenance timers in daemon.ts used to swallow failures with an empty
 * catch block -- "best-effort maintenance", no logging at all -- so a
 * genuine failure (corrupted WAL, disk full) would vanish with zero signal
 * anywhere.
 *
 * Originally fixed with a local log.ts (papyrus's logEvent(level, event,
 * fields) shape); migrated to @danypops/daemon-kit's createLogger, which
 * is pino-backed and therefore uses pino's own field name "msg" for the
 * log message text, not "event". That is a genuine, intentional shape
 * change (not a regression) -- verified directly against daemon-kit's own
 * logging.test.ts, which asserts the same "msg" convention.
 */
import { describe, expect, it } from "bun:test";
import { createLogger } from "@danypops/daemon-kit/logging";

function capture() {
	const lines: string[] = [];
	return { lines, destination: { write: (chunk: string) => { lines.push(chunk); return true; } } };
}

describe("Web Spider daemon logging (via @danypops/daemon-kit's createLogger)", () => {
	it("emits credential-free structured events with the right component and message", () => {
		const { lines, destination } = capture();
		const logger = createLogger("web-spider-daemon", { level: "debug", destination });
		logger.error("checkpoint_failed", { message: "disk full" });
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({ level: "error", component: "web-spider-daemon", msg: "checkpoint_failed", message: "disk full" });
		expect(typeof event["timestamp"]).toBe("string");
		expect(lines[0]).not.toContain("token");
	});

	it("defaults fields to an empty object rather than throwing when omitted", () => {
		const { lines, destination } = capture();
		const logger = createLogger("web-spider-daemon", { level: "debug", destination });
		expect(() => logger.info("listening")).not.toThrow();
		expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "listening" });
	});
});
