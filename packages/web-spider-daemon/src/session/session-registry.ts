import type { SessionInfo } from "./session.ts";

export type FinalizationStageOutcome = "ok" | "error" | "timeout";

export interface SessionFinalizationReport {
	context: FinalizationStageOutcome;
	browser: FinalizationStageOutcome;
	completed: boolean;
}

/**
 * The minimal surface act() dispatch needs from a live page — deliberately
 * not the full Playwright Page type. One SessionPage per session, created
 * lazily and reused across every act() call (tmux-session semantics: a
 * persistent page, not a fresh one per action).
 */
export interface SessionPage {
	goto(url: string, opts?: { timeoutMs?: number }): Promise<void>;
	click(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
	hover(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
	/** Presses a keyboard key. Scoped to selector when given (focuses it first); otherwise a global keyboard press, for keys like Escape with no natural target element. */
	pressKey(key: string, opts?: { selector?: string; timeoutMs?: number }): Promise<void>;
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
	/**
	 * YAML accessibility-tree snapshot (Playwright's real, current, non-
	 * deprecated locator.ariaSnapshot()/page.ariaSnapshot() — the old
	 * page.accessibility.snapshot() is deprecated). Scoped to selector when
	 * given, otherwise the whole page. Unlike every other action here,
	 * Playwright's own default timeout for this specific method is 0 (no
	 * timeout) — the caller (session-service.ts) must supply an explicit
	 * bounded fallback rather than relying on Playwright's own default, as
	 * it does for every other action.
	 */
	snapshot(opts: { selector?: string; depth?: number; boxes?: boolean; mode?: "ai" | "default"; timeoutMs: number }): Promise<string>;
	/**
	 * Arms a one-shot accept/dismiss policy for the next native dialog
	 * (alert/confirm/prompt/beforeunload) on this page — consumed on first
	 * use, then reverts to the safe default (dismiss, matching Playwright's
	 * own real default behavior when no listener is registered at all).
	 * Verified empirically: without any handling, Playwright auto-dismisses
	 * dialogs rather than hanging — this action's job is letting a caller
	 * intentionally *accept* one (or answer a prompt) when that's needed,
	 * not preventing a hang that was never a real risk to begin with.
	 */
	armDialogPolicy(policy: { accept: boolean; promptText?: string }): Promise<void>;
	/**
	 * Every download captured on this page since creation, most recent
	 * last, bounded to SESSION_MAX_DOWNLOADS_TRACKED entries (oldest
	 * evicted first). Each one has already been saved to disk (via a
	 * persistent page.on('download') listener registered at page creation,
	 * the same ordering-safe pattern used for dialogs) by the time it
	 * appears here — this is a read of already-captured metadata, not a
	 * new page interaction.
	 */
	listDownloads(): Promise<Array<{ filename: string; path: string; url: string; failure: string | null }>>;
	/** Every console message logged on this page since creation, most recent last, bounded (oldest evicted first) — buffered by a persistent listener, not queryable retroactively. */
	listConsoleMessages(): Promise<Array<{ type: string; text: string; timestamp: number }>>;
	/** Every network request/response observed on this page since creation, most recent last, bounded — same buffering approach as console messages. */
	listNetworkRequests(): Promise<Array<{ url: string; method: string; status: number; resourceType: string }>>;
	evaluate<T = unknown>(script: string): Promise<T>;
	/**
	 * PNG (or JPEG) bytes. Default is a viewport-only capture, matching
	 * Playwright's own real default — opts.fullPage opts into the whole
	 * scrollable page; opts.selector opts into a single element's own
	 * bounding box instead (mutually exclusive with fullPage, validated
	 * before this is ever called).
	 */
	screenshot(opts?: { fullPage?: boolean; selector?: string; scale?: "css" | "device" }): Promise<Uint8Array>;
}

export interface TabInfo {
	/** Stable opaque identity for this page; never changes when another tab closes and is never reused within the session. */
	pageId: string;
	/** Backward-compatible projection over the current open-page order. May change when an earlier page closes. */
	index: number;
	url: string;
	title: string;
	active: boolean;
}

export interface CreateSessionOptions {
	/**
	 * Force the full installed chrome/chromium channel instead of Playwright's
	 * own bundled Chromium channel. A deliberate, explicit per-call choice,
	 * never a silent default either way.
	 */
	forceChromeChannel?: boolean;
	/**
	 * Show the browser window so a human can take over for CAPTCHA, login, or
	 * consent. The same persistent page remains attached after the human is
	 * done, so agent automation can resume with its cookies/storage intact.
	 * Defaults to false; background automation must never unexpectedly open UI.
	 */
	headed?: boolean;
}

/**
 * Core session lifecycle — create/list/close only. Action dispatch
 * (navigate/click/type/eval) is a later task's concern
 * (daemon-operations-cli-parity-sessioncreatelistcloseact-with--dw0n);
 * this port is deliberately narrow so that task can depend on a stable,
 * already-tested foundation.
 *
 * Isolation model: one owned Playwright Browser process and one explicit
 * BrowserContext per named session. Tabs inside that context share cookies,
 * cache, and origin storage; separate named sessions remain process-isolated
 * from each other and the operator's own browser. No storageState plumbing
 * is required for isolation itself.
 */
export interface SessionRegistry {
	/** Rejects (does not silently queue or evict) once the concurrent-session ceiling is reached. */
	create(name: string, opts?: CreateSessionOptions): Promise<SessionInfo>;
	list(): SessionInfo[];
	get(name: string): SessionInfo | undefined;
	/** The session's one persistent page, for act() dispatch. Throws for an unknown session. */
	page(name: string): Promise<SessionPage>;
	/** Destination-idempotent after success. A finalization failure retains ownership so retrying the same name can complete cleanup; only a never-known name errors. */
	close(name: string): Promise<SessionFinalizationReport>;
	/** Refreshes the reported snapshotVersion from the active page's browser-event-driven navigation revision without bumping it. Throws for an unknown session. */
	touchActivity(name: string): SessionInfo;
	/** Lists every open page in current index order, including automatically discovered popups. Each result also has a stable pageId. Throws for an unknown session. */
	listTabs(name: string): Promise<TabInfo[]>;
	/** Opens a new tab in the session's explicit shared context (optionally navigating it immediately), makes it active with a fresh snapshotVersion of 0, and returns stable-ID info. Rejects past SESSION_MAX_TABS. Throws for an unknown session. */
	newTab(name: string, url?: string): Promise<TabInfo>;
	/** Closes a tab (defaults to the active one). If the active tab is closed, activation falls back to the tab now at the same index, or the last remaining tab, or null if none remain — documented, deterministic, not implicit. Throws for an unknown session or an out-of-range tabIndex. */
	closeTab(name: string, tabIndex?: number): Promise<{ closedIndex: number; newActiveIndex: number | null }>;
	/** Switches the active tab, surfacing its own already-tracked snapshotVersion. Throws for an unknown session or an out-of-range tabIndex. */
	selectTab(name: string, tabIndex: number): Promise<TabInfo>;
	/** Daemon-shutdown hygiene — independently attempts every non-finalized session. Never throws; failed runtimes remain retained for a later bounded retry. */
	closeAll(): Promise<void>;
}
