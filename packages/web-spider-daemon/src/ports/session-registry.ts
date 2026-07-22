import type { SessionInfo } from "../domain/session.ts";

/**
 * The minimal surface act() dispatch needs from a live page — deliberately
 * not the full Playwright Page type. One SessionPage per session, created
 * lazily and reused across every act() call (tmux-session semantics: a
 * persistent page, not a fresh one per action).
 */
export interface SessionPage {
	goto(url: string, opts?: { timeoutMs?: number }): Promise<void>;
	click(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
	/**
	 * Real per-character keyboard input (Playwright's pressSequentially, not
	 * a synthetic DOM event) — the primitive a caller needs for pages with
	 * their own JS keyboard/input handling (framework-bound form fields that
	 * don't react to a directly-set .value). Clears existing content first
	 * unless opts.clear is explicitly false.
	 */
	type(selector: string, text: string, opts?: { timeoutMs?: number; clear?: boolean }): Promise<void>;
	/** Selects a <select> option by its value attribute or visible label — exactly one of target.value/target.label is set. */
	select(selector: string, target: { value?: string; label?: string }, opts?: { timeoutMs?: number }): Promise<void>;
	/**
	 * Waits for a real condition before returning — replaces blind sleeps.
	 * Exactly one of target.selector/target.text/target.loadState is set.
	 * Bounded the same way every other action here is: Playwright's own
	 * default timeout applies when opts.timeoutMs is omitted, never an
	 * unbounded wait.
	 */
	waitFor(
		target: { selector?: string; text?: string; loadState?: "load" | "domcontentloaded" | "networkidle" },
		opts?: { timeoutMs?: number; state?: "visible" | "hidden" | "attached" | "detached" },
	): Promise<void>;
	/** Trimmed text content of every element matching selector, in document order — structured data instead of dumping innerText and grepping by hand. */
	queryText(selector: string, opts?: { timeoutMs?: number }): Promise<string[]>;
	/** Rows of trimmed cell text for every <tr> within the element matching selector (its own <td>/<th> descendants, not nested tables' rows). */
	readTable(selector: string, opts?: { timeoutMs?: number }): Promise<string[][]>;
	evaluate<T = unknown>(script: string): Promise<T>;
	/** PNG bytes of the full page. */
	screenshot(): Promise<Uint8Array>;
}

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
	/** The session's one persistent page, for act() dispatch. Throws for an unknown session. */
	page(name: string): Promise<SessionPage>;
	/** Idempotent-in-error-shape: closing an unknown or already-closed session throws a clear, typed error. */
	close(name: string): Promise<void>;
	/** Bumps and returns the session's snapshot version (called after a successful navigate). Throws for an unknown session. */
	bumpSnapshotVersion(name: string): SessionInfo;
	/** Touches lastActivityAt without changing snapshotVersion (called after a successful click/eval/screenshot). Throws for an unknown session. */
	touchActivity(name: string): SessionInfo;
	/** Daemon-shutdown hygiene — tears down every live session. Never throws; best-effort. */
	closeAll(): Promise<void>;
}
