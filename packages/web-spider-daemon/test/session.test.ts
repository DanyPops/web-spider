import { describe, expect, test } from "bun:test";
import { createSessionInfo, isValidSessionName, withBumpedSnapshotVersion, withClosed, withTouchedActivity } from "../src/domain/session.ts";

describe("isValidSessionName", () => {
	test("accepts alphanumeric, dash, underscore, starting with a letter or digit", () => {
		for (const name of ["a", "agent1", "agent-1", "agent_1", "A1-b_2"]) {
			expect(isValidSessionName(name, 64)).toBe(true);
		}
	});

	test("rejects empty, oversized, and names with disallowed characters", () => {
		expect(isValidSessionName("", 64)).toBe(false);
		expect(isValidSessionName("a".repeat(65), 64)).toBe(false);
		expect(isValidSessionName("-leading-dash", 64)).toBe(false);
		expect(isValidSessionName("has space", 64)).toBe(false);
		expect(isValidSessionName("has/slash", 64)).toBe(false);
		expect(isValidSessionName("has.dot", 64)).toBe(false);
		expect(isValidSessionName("../../etc/passwd", 64)).toBe(false);
	});

	test("respects the configured max length exactly (boundary)", () => {
		expect(isValidSessionName("a".repeat(64), 64)).toBe(true);
		expect(isValidSessionName("a".repeat(65), 64)).toBe(false);
	});
});

describe("SessionInfo lifecycle helpers", () => {
	test("createSessionInfo starts at snapshotVersion 0, open", () => {
		const info = createSessionInfo("agent1", 1_000);
		expect(info).toEqual({ name: "agent1", createdAt: 1_000, lastActivityAt: 1_000, snapshotVersion: 0, closed: false });
	});

	test("withBumpedSnapshotVersion increments the counter and touches activity, without mutating the input", () => {
		const original = createSessionInfo("agent1", 1_000);
		const bumped = withBumpedSnapshotVersion(original, 2_000);
		expect(bumped).toEqual({ name: "agent1", createdAt: 1_000, lastActivityAt: 2_000, snapshotVersion: 1, closed: false });
		expect(original.snapshotVersion).toBe(0);
	});

	test("withTouchedActivity updates lastActivityAt only", () => {
		const original = createSessionInfo("agent1", 1_000);
		const touched = withTouchedActivity(original, 5_000);
		expect(touched).toEqual({ ...original, lastActivityAt: 5_000 });
	});

	test("withClosed sets closed:true without touching other fields", () => {
		const original = createSessionInfo("agent1", 1_000);
		const closed = withClosed(original);
		expect(closed).toEqual({ ...original, closed: true });
	});
});
