/**
 * Pure domain types and validation for browser sessions — no Playwright
 * import here, so this stays trivially unit-testable. See design doc
 * decision-extend-web-spider-daemon-with-tmux-style-browser-se-ua4l.
 */

/** Bounds match constants.ts SESSION_NAME_MAX_LENGTH; kept in sync there. */
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface SessionInfo {
	name: string;
	createdAt: number;
	lastActivityAt: number;
	/**
	 * Monotonic counter, incremented on every navigation. Lets a future
	 * caller detect "the page changed under me between snapshot and action"
	 * (Seeshell-derived freshness requirement) — this module only owns the
	 * counter itself; incrementing on real navigation is the "act" daemon
	 * operation's responsibility (a later task), not this registry's.
	 */
	snapshotVersion: number;
	/** True once close() has completed; a closed session is never reused. */
	closed: boolean;
}

export function isValidSessionName(name: string, maxLength: number): boolean {
	if (typeof name !== "string" || name.length === 0 || name.length > maxLength) return false;
	return SESSION_NAME_PATTERN.test(name);
}

export function createSessionInfo(name: string, now: number): SessionInfo {
	return { name, createdAt: now, lastActivityAt: now, snapshotVersion: 0, closed: false };
}

export function withBumpedSnapshotVersion(info: SessionInfo, now: number): SessionInfo {
	return { ...info, snapshotVersion: info.snapshotVersion + 1, lastActivityAt: now };
}

export function withTouchedActivity(info: SessionInfo, now: number): SessionInfo {
	return { ...info, lastActivityAt: now };
}

export function withClosed(info: SessionInfo): SessionInfo {
	return { ...info, closed: true };
}
