import type { SessionInfo } from "../domain/session.ts";

export interface CreateSessionOptions {
	/**
	 * Force the full installed chrome/chromium channel instead of Playwright's
	 * own default (chromium-headless-shell in headless mode). A deliberate,
	 * explicit per-call choice — see research doc
	 * research-lightweight-browser-engine-options-for-the-session--0z7r —
	 * never a silent default either way.
	 */
	forceChromeChannel?: boolean;
}

/**
 * Core session lifecycle — create/list/close only. Action dispatch
 * (navigate/click/type/eval) is a later task's concern
 * (daemon-operations-cli-parity-sessioncreatelistcloseact-with--dw0n);
 * this port is deliberately narrow so that task can depend on a stable,
 * already-tested foundation.
 *
 * Isolation model: one owned Playwright Browser process per named session
 * (agent-browser's full-process-per-session semantics, not
 * browser.newContext()) — a session's cookies/storage/navigation history
 * are never shared with another session or the operator's own browser.
 * Full process isolation gets this "never shared" property for free (each
 * launched browser gets its own separate temporary profile directory) —
 * no explicit storageState plumbing is required for isolation itself.
 */
export interface SessionRegistry {
	/** Rejects (does not silently queue or evict) once the concurrent-session ceiling is reached. */
	create(name: string, opts?: CreateSessionOptions): Promise<SessionInfo>;
	list(): SessionInfo[];
	get(name: string): SessionInfo | undefined;
	/** Idempotent-in-error-shape: closing an unknown or already-closed session throws a clear, typed error. */
	close(name: string): Promise<void>;
	/** Daemon-shutdown hygiene — tears down every live session. Never throws; best-effort. */
	closeAll(): Promise<void>;
}
