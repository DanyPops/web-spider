/**
 * Playwright-backed SessionRegistry — one owned Browser process per named
 * session, with one explicit BrowserContext inside that process. Tabs in a
 * session share cookies/cache/origin storage while separate named sessions
 * remain process-isolated from each other and the operator's own browser.
 *
 * Default launch uses channel:"chromium" (Playwright's own bundled build,
 * "new headless mode") — never channel:"chrome" (the operator's own system-
 * installed, branded Chrome) unless forceChromeChannel opts in. `headed`
 * only changes whether that explicitly selected browser shows a window; it
 * never silently changes the channel. This is a revision of an earlier
 * decision to leave headless: true unspecified, which resolves to
 * Playwright's separate, legacy "chromium-headless-shell" build: found
 * unreliable for a real, deterministic, CI-reproduced case
 * (a JS confirm() dialog's click() action hanging to a 30s timeout, not
 * sporadic — reproduced twice in a row). Chrome's own documentation
 * describes new headless mode as "the real Chrome browser... more
 * authentic, reliable, and offers more features" than the legacy shell.
 * channel:"chromium" keeps this fully Playwright's own open-source build
 * (never the operator's system Chrome), just a more reliable launch mode
 * of it — not a reversal of the "never silently force chrome" principle.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	SESSION_MAX_CONSOLE_MESSAGES_TRACKED,
	SESSION_MAX_DOWNLOADS_TRACKED,
	SESSION_MAX_NETWORK_REQUESTS_TRACKED,
	SESSION_MAX_TABS,
	SESSION_NAME_MAX_LENGTH,
	SESSION_REGISTRY_MAX_CONCURRENT,
} from "../constants.ts";
import { createSessionInfo, isValidSessionName, type SessionInfo, withClosed } from "./session.ts";
import type {
	CreateSessionOptions,
	FinalizationStageOutcome,
	SessionFinalizationReport,
	SessionPage,
	SessionRegistry,
	TabInfo,
} from "./session-registry.ts";

/**
 * The minimal surface this module needs from a launched browser. Manages
 * potentially multiple tabs (real Playwright pages) within the one owned
 * browser process — index-addressed, matching Playwright MCP's own tab
 * convention. Each tab tracks its own snapshotVersion independently (a
 * stale-snapshot check is fundamentally about one page's navigation state,
 * not the session as a whole) — page()/the active-tab accessors always
 * reflect whichever tab was most recently selected (or created), and
 * PlaywrightSessionRegistry surfaces that tab's own version as the
 * session's reported snapshotVersion after every action.
 */
export class SessionFinalizationError extends Error {
	constructor(
		message: string,
		readonly report: SessionFinalizationReport,
	) {
		super(message);
		this.name = "SessionFinalizationError";
	}
}

export type BrowserSessionEvent =
	| { kind: "lifecycle"; sessionName: string; state: "starting" | "open" | "closing" | "close-failed" | "closed" }
	| { kind: "page"; sessionName: string; pageId: string; state: "open" | "closed" | "crashed" }
	| { kind: "navigation"; sessionName: string; pageId: string; frameId: "frame-1"; revision: number; url: string; mainFrame: true }
	| { kind: "frame-navigation"; sessionName: string; pageId: string; frameId: string; url: string; mainFrame: false }
	| { kind: "finalization"; sessionName: string; stage: "context" | "browser"; outcome: FinalizationStageOutcome };

export type BrowserSessionObserver = (event: BrowserSessionEvent) => void | Promise<void>;

function boundedObserverEmitter(observer: BrowserSessionObserver | undefined, logger?: Logger, maxQueued = 100) {
	const queue: BrowserSessionEvent[] = [];
	let draining = false;
	const drain = async () => {
		if (draining) return;
		draining = true;
		try {
			while (queue.length > 0) {
				const event = queue.shift() as BrowserSessionEvent;
				try {
					await observer?.(event);
				} catch (error) {
					logger?.warn("session_observer_failed", { error: String(error), kind: event.kind });
				}
			}
		} finally {
			draining = false;
		}
	};
	return (event: BrowserSessionEvent) => {
		if (!observer) return;
		if (queue.length >= maxQueued) {
			logger?.warn("session_observer_overflow", { maxQueued, kind: event.kind });
			return;
		}
		queue.push(event);
		void drain();
	};
}

export interface BrowserSessionRuntime {
	close(opts?: { timeoutMs?: number }): Promise<SessionFinalizationReport>;
	/** The currently active tab's persistent page. Lazily creates tab 0 on first call; returns the active tab's page on every subsequent call. */
	page(): Promise<SessionPage>;
	listTabs(): Promise<TabInfo[]>;
	newTab(url?: string): Promise<TabInfo>;
	closeTab(tabIndex?: number): Promise<{ closedIndex: number; newActiveIndex: number | null }>;
	selectTab(tabIndex: number): Promise<TabInfo>;
	/** The active tab's own event-driven navigation revision, without changing it. 0 if no tab has ever been created. */
	activeSnapshotVersion(): number;
}

export type BrowserLauncher = (opts: {
	forceChromeChannel: boolean;
	headed: boolean;
	downloadsDir: string;
	sessionName: string;
	emitEvent: (event: BrowserSessionEvent) => void;
}) => Promise<BrowserSessionRuntime>;

interface Tab {
	pageId: string;
	playwrightPage: PlaywrightPageLike;
	sessionPage: SessionPage;
	version: number;
}

interface PlaywrightBrowserContextLike {
	newPage(): Promise<PlaywrightPageLike>;
	on(event: "page", handler: (page: PlaywrightPageLike) => void): void;
	close(): Promise<void>;
}

interface PlaywrightBrowserLike {
	newContext(): Promise<PlaywrightBrowserContextLike>;
	close(): Promise<void>;
}

export async function createBrowserSessionRuntime(
	browser: PlaywrightBrowserLike,
	downloadsDir: string,
	logger?: Logger,
	events?: { sessionName: string; emit: (event: BrowserSessionEvent) => void },
): Promise<BrowserSessionRuntime> {
	let context: PlaywrightBrowserContextLike;
	try {
		context = await browser.newContext();
	} catch (error) {
		try {
			await browser.close();
		} catch (closeError) {
			logger?.warn("session_browser_cleanup_failed", { error: String(closeError), stage: "context-creation" });
		}
		throw error;
	}
	const tabs: Tab[] = [];
	const tabByPage = new Map<PlaywrightPageLike, Tab>();
	let activePageId: string | null = null;
	let nextPageNumber = 1;
	let ensureFirstTabPromise: Promise<void> | undefined;

	const activeIndex = () => tabs.findIndex((tab) => tab.pageId === activePageId);

	function unregisterPage(playwrightPage: PlaywrightPageLike, state?: "closed" | "crashed"): void {
		const tab = tabByPage.get(playwrightPage);
		if (!tab) return;
		const closedIndex = tabs.indexOf(tab);
		tabByPage.delete(playwrightPage);
		tabs.splice(closedIndex, 1);
		if (activePageId === tab.pageId) {
			activePageId = tabs[Math.min(closedIndex, tabs.length - 1)]?.pageId ?? null;
		}
		if (state && events) events.emit({ kind: "page", sessionName: events.sessionName, pageId: tab.pageId, state });
	}

	function registerPage(playwrightPage: PlaywrightPageLike): Tab | undefined {
		const existing = tabByPage.get(playwrightPage);
		if (existing) return existing;
		if (tabs.length >= SESSION_MAX_TABS) {
			logger?.warn("session_tab_limit_exceeded", { maxTabs: SESSION_MAX_TABS });
			void playwrightPage.close().catch((error) => {
				logger?.warn("session_excess_tab_close_failed", { error: String(error) });
			});
			return undefined;
		}
		const tab = {
			pageId: `page-${nextPageNumber++}`,
			playwrightPage,
			sessionPage: wrapPlaywrightPage(playwrightPage, downloadsDir, logger),
			version: 0,
		};
		tabByPage.set(playwrightPage, tab);
		tabs.push(tab);
		activePageId = tab.pageId;
		const mainFrame = playwrightPage.mainFrame();
		const frameIds = new Map<PlaywrightFrameLike, string>([[mainFrame, "frame-1"]]);
		const pendingNavigationCallbacks = new Set<string>();
		let nextFrameNumber = 2;
		playwrightPage.on("framenavigated", (frame) => {
			// A revision describes committed top-level navigation state. Frame-only
			// navigation and arbitrary DOM mutation deliberately do not invalidate
			// callers. Playwright emits this for agent and human navigations alike.
			const url = frame.url();
			if (url === "about:blank") return;
			let frameId = frameIds.get(frame);
			if (!frameId) {
				frameId = `frame-${nextFrameNumber++}`;
				frameIds.set(frame, frameId);
			}
			const callbackKey = `${frameId}\0${url}`;
			if (pendingNavigationCallbacks.has(callbackKey)) return;
			pendingNavigationCallbacks.add(callbackKey);
			queueMicrotask(() => pendingNavigationCallbacks.delete(callbackKey));
			if (frame === mainFrame) {
				tab.version += 1;
				if (events)
					events.emit({
						kind: "navigation",
						sessionName: events.sessionName,
						pageId: tab.pageId,
						frameId: "frame-1",
						revision: tab.version,
						url,
						mainFrame: true,
					});
			} else if (events) {
				events.emit({ kind: "frame-navigation", sessionName: events.sessionName, pageId: tab.pageId, frameId, url, mainFrame: false });
			}
		});
		playwrightPage.on("close", () => unregisterPage(playwrightPage, "closed"));
		playwrightPage.on("crash", () => unregisterPage(playwrightPage, "crashed"));
		if (events) events.emit({ kind: "page", sessionName: events.sessionName, pageId: tab.pageId, state: "open" });
		return tab;
	}

	// Context-level discovery sees popups and human-created tabs that never
	// pass through registry.newTab(). registerPage is idempotent because
	// context.newPage() also emits this event before resolving.
	try {
		context.on("page", registerPage);
	} catch (error) {
		try {
			await context.close();
		} catch (closeError) {
			logger?.warn("session_context_cleanup_failed", { error: String(closeError), stage: "page-listener-setup" });
		}
		try {
			await browser.close();
		} catch (closeError) {
			logger?.warn("session_browser_cleanup_failed", { error: String(closeError), stage: "page-listener-setup" });
		}
		throw error;
	}

	// Idempotent and safe to call from any method — the first real access
	// (page(), listTabs(), etc.) lazily creates tab 0, exactly matching the
	// pre-multi-tab behavior for every caller that never touches tabs at all.
	function ensureFirstTab(): Promise<void> {
		if (!ensureFirstTabPromise) {
			ensureFirstTabPromise = context.newPage().then((playwrightPage) => {
				const tab = registerPage(playwrightPage);
				if (!tab) throw new Error(`tab limit reached (${SESSION_MAX_TABS} tabs max per session)`);
				activePageId = tab.pageId;
			});
		}
		return ensureFirstTabPromise;
	}

	async function describeTab(index: number): Promise<TabInfo> {
		const tab = tabs[index] as Tab;
		return {
			pageId: tab.pageId,
			index,
			url: tab.playwrightPage.url(),
			title: await tab.playwrightPage.title(),
			active: tab.pageId === activePageId,
		};
	}

	let closedReport: SessionFinalizationReport | undefined;
	let closePromise: Promise<SessionFinalizationReport> | undefined;
	async function runFinalizationStage(
		action: () => Promise<void>,
		timeoutMs: number,
	): Promise<{ outcome: FinalizationStageOutcome; error?: unknown }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				action(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`finalization timed out after ${timeoutMs}ms`)), timeoutMs);
					timer.unref?.();
				}),
			]);
			return { outcome: "ok" };
		} catch (error) {
			return { outcome: error instanceof Error && error.message.startsWith("finalization timed out") ? "timeout" : "error", error };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async function closeRuntime(opts: { timeoutMs?: number } = {}): Promise<SessionFinalizationReport> {
		if (closedReport) return closedReport;
		if (closePromise) return closePromise;
		const timeoutMs = opts.timeoutMs ?? 10_000;
		closePromise = (async () => {
			const contextResult = await runFinalizationStage(() => context.close(), timeoutMs);
			if (events) events.emit({ kind: "finalization", sessionName: events.sessionName, stage: "context", outcome: contextResult.outcome });

			const browserResult = await runFinalizationStage(() => browser.close(), timeoutMs);
			if (events) events.emit({ kind: "finalization", sessionName: events.sessionName, stage: "browser", outcome: browserResult.outcome });

			const report: SessionFinalizationReport = {
				context: contextResult.outcome,
				browser: browserResult.outcome,
				completed: contextResult.outcome === "ok" && browserResult.outcome === "ok",
			};
			if (!report.completed) {
				if (contextResult.error && browserResult.error)
					logger?.warn("session_browser_cleanup_failed", { error: String(browserResult.error), stage: "runtime-close" });
				const primary = contextResult.error ?? browserResult.error;
				throw new SessionFinalizationError(String(primary ?? "session finalization failed"), report);
			}
			closedReport = report;
			return report;
		})();
		try {
			return await closePromise;
		} finally {
			if (!closedReport) closePromise = undefined;
		}
	}

	return {
		close: closeRuntime,
		page: async () => {
			await ensureFirstTab();
			const tab = tabs.find((candidate) => candidate.pageId === activePageId);
			if (!tab) throw new Error("session has no open tabs");
			return tab.sessionPage;
		},
		listTabs: async () => {
			await ensureFirstTab();
			return Promise.all(tabs.map((_, index) => describeTab(index)));
		},
		newTab: async (url) => {
			await ensureFirstTab();
			if (tabs.length >= SESSION_MAX_TABS)
				throw new Error(`tab limit reached (${SESSION_MAX_TABS} tabs max per session) — close a tab first`);
			const playwrightPage = await context.newPage();
			const tab = registerPage(playwrightPage);
			if (!tab) throw new Error(`tab limit reached (${SESSION_MAX_TABS} tabs max per session) — close a tab first`);
			activePageId = tab.pageId;
			if (url !== undefined) await playwrightPage.goto(url);
			return describeTab(tabs.indexOf(tab));
		},
		closeTab: async (tabIndex) => {
			await ensureFirstTab();
			const indexToClose = tabIndex ?? activeIndex();
			if (indexToClose < 0 || indexToClose >= tabs.length) throw new Error(`no such tab: ${indexToClose}`);
			const pageToClose = (tabs[indexToClose] as Tab).playwrightPage;
			await pageToClose.close();
			unregisterPage(pageToClose);
			const newActiveIndex = activeIndex();
			return { closedIndex: indexToClose, newActiveIndex: newActiveIndex >= 0 ? newActiveIndex : null };
		},
		selectTab: async (tabIndex) => {
			await ensureFirstTab();
			if (tabIndex < 0 || tabIndex >= tabs.length) throw new Error(`no such tab: ${tabIndex}`);
			activePageId = (tabs[tabIndex] as Tab).pageId;
			return describeTab(tabIndex);
		},
		activeSnapshotVersion: () => tabs.find((tab) => tab.pageId === activePageId)?.version ?? 0,
	};
}

// The minimal subset of Playwright's real Page/Locator types this module
// drives — avoids a hard type dependency on playwright-core's own types
// package.
// This module has no "dom" lib (it's a Node/Bun daemon, not browser code) —
// a minimal duck-typed shape is all evaluate()'s callback needs; it only
// ever actually runs inside the browser, serialized over CDP.
interface MinimalDomElement {
	querySelectorAll(selector: string): ArrayLike<MinimalDomElement>;
	textContent: string | null;
}

interface PlaywrightLocatorLike {
	fill(value: string, opts?: { timeout?: number }): Promise<void>;
	pressSequentially(text: string, opts?: { timeout?: number }): Promise<void>;
	selectOption(target: { value: string } | { label: string }, opts?: { timeout?: number }): Promise<string[]>;
	hover(opts?: { timeout?: number }): Promise<void>;
	/** Also used internally to position the cursor at the end of existing content before an appending (clear:false) type. */
	press(key: string, opts?: { timeout?: number }): Promise<void>;
	waitFor(opts?: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number }): Promise<void>;
	/** Trimmed text content of every element the locator matched — Playwright's own built-in primitive, not a hand-rolled innerText dump. */
	allTextContents(): Promise<string[]>;
	/** Runs a fixed, daemon-authored function against the matched element — never caller-supplied script (that's the eval action's job, deliberately kept separate). */
	evaluate<T>(fn: (el: MinimalDomElement) => T, arg: undefined, opts?: { timeout?: number }): Promise<T>;
	/** Screenshot of just this element's own bounding box. */
	screenshot(opts?: { scale?: "css" | "device" }): Promise<Uint8Array>;
	ariaSnapshot(opts?: { depth?: number; boxes?: boolean; mode?: "ai" | "default"; timeout?: number }): Promise<string>;
}

export interface PlaywrightDialogLike {
	accept(promptText?: string): Promise<void>;
	dismiss(): Promise<void>;
}

export interface PlaywrightDownloadLike {
	suggestedFilename(): string;
	saveAs(path: string): Promise<void>;
	url(): string;
	failure(): Promise<string | null>;
}

interface PlaywrightConsoleMessageLike {
	type(): string;
	text(): string;
}

interface PlaywrightRequestLike {
	url(): string;
	method(): string;
	resourceType(): string;
}

interface PlaywrightResponseLike {
	url(): string;
	status(): number;
	request(): PlaywrightRequestLike;
}

export interface PlaywrightFrameLike {
	url(): string;
}

export interface PlaywrightPageLike {
	goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
	click(selector: string, opts?: { timeout?: number }): Promise<void>;
	url(): string;
	title(): Promise<string>;
	close(): Promise<void>;
	locator(selector: string): PlaywrightLocatorLike;
	/** Text-content locator (Playwright's own escaping, not a hand-built :text() selector string). */
	getByText(text: string): PlaywrightLocatorLike;
	waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", opts?: { timeout?: number }): Promise<void>;
	evaluate(script: string): Promise<unknown>;
	screenshot(opts?: { fullPage?: boolean; scale?: "css" | "device" }): Promise<Uint8Array>;
	ariaSnapshot(opts?: { depth?: number; boxes?: boolean; mode?: "ai" | "default"; timeout?: number }): Promise<string>;
	on(event: "dialog", handler: (dialog: PlaywrightDialogLike) => void | Promise<void>): void;
	on(event: "download", handler: (download: PlaywrightDownloadLike) => void | Promise<void>): void;
	on(event: "console", handler: (message: PlaywrightConsoleMessageLike) => void | Promise<void>): void;
	on(event: "response", handler: (response: PlaywrightResponseLike) => void | Promise<void>): void;
	on(event: "framenavigated", handler: (frame: PlaywrightFrameLike) => void | Promise<void>): void;
	on(event: "close" | "crash", handler: () => void | Promise<void>): void;
	mainFrame(): PlaywrightFrameLike;
	/** Global keyboard press, not tied to any element — for keys like Escape with no natural target. Real Playwright API has no timeout option here (there's no element to wait for). */
	keyboard: { press(key: string): Promise<void> };
}

export function wrapPlaywrightPage(page: PlaywrightPageLike, downloadsDir: string, logger?: Logger): SessionPage {
	// Registered once, at page creation, so no dialog triggered by any
	// future action can ever occur before this exists (solves the real
	// ordering problem: a dialog can appear as a side effect of the very
	// next action, with no separate opportunity to "arm" a handler first).
	// One-shot: consumed on the next dialog regardless of outcome, then
	// reverts to this project's own safe default — dismiss, matching
	// Playwright's own real default when no listener is registered at all.
	let armedPolicy: { accept: boolean; promptText?: string } | undefined;
	page.on("dialog", async (dialog) => {
		const policy = armedPolicy;
		armedPolicy = undefined;
		try {
			if (policy?.accept) {
				await dialog.accept(policy.promptText);
			} else {
				await dialog.dismiss();
			}
		} catch (error) {
			// Playwright never awaits this handler — an uncaught rejection here
			// would be an unhandled promise rejection, not an error any caller
			// could ever catch. Swallow it, but make the failure observable.
			logger?.warn("session_dialog_handler_failed", { error: String(error) });
		}
	});

	// Same ordering-safe pattern as dialogs: registered once, at page
	// creation, so a download triggered by any future action is always
	// captured — never relies on the triggering action's own promise having
	// already resolved by the time anyone checks (verified empirically:
	// Playwright's own recommended pattern races waitForEvent('download')
	// against the click rather than checking after, precisely because the
	// click resolving does not reliably mean the download has already
	// fired).
	const downloads: Array<{ filename: string; path: string; url: string; failure: string | null }> = [];
	page.on("download", async (download) => {
		const filename = download.suggestedFilename();
		const path = join(downloadsDir, filename);
		try {
			await download.saveAs(path);
			downloads.push({ filename, path, url: download.url(), failure: await download.failure() });
			if (downloads.length > SESSION_MAX_DOWNLOADS_TRACKED) downloads.shift();
		} catch (error) {
			// Same rationale as the dialog handler above: nothing awaits this
			// handler, so an uncaught rejection here (e.g. disk full, permission
			// denied, invalid downloadsDir) would be unhandled, not catchable by
			// any caller. Swallow it, but make the failure observable.
			logger?.warn("session_download_handler_failed", { error: String(error), filename });
		}
	});

	// Same bounded-buffer pattern — registered once at page creation so
	// nothing observed before a caller thinks to ask for it is ever lost.
	// Console/network events fire far more often than dialogs/downloads,
	// hence the larger bound.
	const consoleMessages: Array<{ type: string; text: string; timestamp: number }> = [];
	page.on("console", (message) => {
		consoleMessages.push({ type: message.type(), text: message.text(), timestamp: Date.now() });
		if (consoleMessages.length > SESSION_MAX_CONSOLE_MESSAGES_TRACKED) consoleMessages.shift();
	});

	const networkRequests: Array<{ url: string; method: string; status: number; resourceType: string }> = [];
	page.on("response", (response) => {
		const request = response.request();
		networkRequests.push({
			url: response.url(),
			method: request.method(),
			status: response.status(),
			resourceType: request.resourceType(),
		});
		if (networkRequests.length > SESSION_MAX_NETWORK_REQUESTS_TRACKED) networkRequests.shift();
	});

	return {
		goto: async (url, opts) => {
			await page.goto(url, opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined);
		},
		click: (selector, opts) => page.click(selector, opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined),
		hover: (selector, opts) => page.locator(selector).hover(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined),
		pressKey: (key, opts) => {
			if (opts?.selector !== undefined) {
				const timeoutOpt = opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
				return page.locator(opts.selector).press(key, timeoutOpt);
			}
			return page.keyboard.press(key);
		},
		type: async (selector, text, opts) => {
			const timeoutOpt = opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
			const locator = page.locator(selector);
			// pressSequentially (real per-key keydown/keypress/input/keyup, driven
			// through CDP like a real user's keystrokes) rather than fill()'s
			// single synthetic input event — the primitive pages with their own
			// JS-bound keyboard handling actually need (see decision doc on the
			// O-RAN Blazor-Server search box that motivated this task).
			if (opts?.clear !== false) {
				await locator.fill("", timeoutOpt);
			} else {
				// pressSequentially types at the current cursor position, which
				// defaults to the start of any existing content, not the end —
				// without this, clear:false silently prepends instead of
				// appending (a real, test-caught gap while building this).
				await locator.press("End", timeoutOpt);
			}
			await locator.pressSequentially(text, timeoutOpt);
		},
		select: async (selector, target, opts) => {
			const timeoutOpt = opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
			const option = target.value !== undefined ? { value: target.value } : { label: target.label as string };
			await page.locator(selector).selectOption(option, timeoutOpt);
		},
		waitFor: async (target, opts) => {
			const timeoutOpt = opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
			if (target.loadState !== undefined) {
				await page.waitForLoadState(target.loadState, timeoutOpt);
				return;
			}
			const locator = target.selector !== undefined ? page.locator(target.selector) : page.getByText(target.text as string);
			await locator.waitFor({ ...(opts?.state !== undefined ? { state: opts.state } : {}), ...timeoutOpt });
		},
		queryText: async (selector, _opts) => {
			const texts = await page.locator(selector).allTextContents();
			return texts.map((t) => t.trim());
		},
		readTable: async (selector, opts) => {
			const timeoutOpt = opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
			return page.locator(selector).evaluate(
				(el) => {
					// :scope-rooted so a nested table's own rows are never captured as
					// if they belonged to the matched (outer) table.
					const rows = el.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr");
					return Array.from(rows).map((row) =>
						Array.from(row.querySelectorAll(":scope > td, :scope > th")).map((cell) => (cell.textContent ?? "").trim()),
					);
				},
				undefined,
				timeoutOpt,
			);
		},
		snapshot: (opts) => {
			const ariaOpts = { depth: opts?.depth, boxes: opts?.boxes, mode: opts?.mode, timeout: opts?.timeoutMs };
			if (opts?.selector !== undefined) return page.locator(opts.selector).ariaSnapshot(ariaOpts);
			return page.ariaSnapshot(ariaOpts);
		},
		armDialogPolicy: async (policy) => {
			armedPolicy = policy;
		},
		listDownloads: async () => [...downloads],
		listConsoleMessages: async () => [...consoleMessages],
		listNetworkRequests: async () => [...networkRequests],
		evaluate: <T>(script: string) => page.evaluate(script) as Promise<T>,
		screenshot: (opts) => {
			if (opts?.selector !== undefined) return page.locator(opts.selector).screenshot({ scale: opts.scale });
			return page.screenshot({ fullPage: opts?.fullPage, scale: opts?.scale });
		},
	};
}

export function resolveBrowserLaunchOptions(
	forceChromeChannel: boolean,
	headed: boolean,
): {
	channel: "chrome" | "chromium";
	headless: boolean;
	args: string[];
} {
	// --disable-dev-shm-usage: Chromium's default /dev/shm is often too small in a
	// container/CI sandbox, and exhausting it OOM-kills the renderer -- routes shared
	// memory through /tmp instead, which uses the container's normal memory budget.
	return { channel: forceChromeChannel ? "chrome" : "chromium", headless: !headed, args: ["--disable-dev-shm-usage"] };
}

/** Real launcher — lazily imports playwright-core so importing this module never requires the browser binary to be installed. */
export function defaultBrowserLauncher(logger?: Logger): BrowserLauncher {
	return async ({ forceChromeChannel, headed, downloadsDir, sessionName, emitEvent }) => {
		const { chromium } = await import("playwright-core");
		const browser = await chromium.launch(resolveBrowserLaunchOptions(forceChromeChannel, headed));
		mkdirSync(downloadsDir, { recursive: true });
		return await createBrowserSessionRuntime(browser, downloadsDir, logger, { sessionName, emit: emitEvent });
	};
}

export interface PlaywrightSessionRegistryOptions {
	launcher?: BrowserLauncher;
	maxConcurrent?: number;
	maxNameLength?: number;
	now?: () => number;
	/** Base directory downloaded files are saved under, one subdirectory per session name. Defaults to a directory under the OS temp dir if omitted — callers wiring the real daemon should pass the real XDG-based path (see service.ts). */
	downloadsBaseDir?: string;
	/** Structured logger for otherwise-unobservable failures (dialog/download event handlers that nothing awaits). Optional so existing tests/wiring that don't care about it keep working unchanged. */
	logger?: Logger;
	/** Bounded, failure-isolated mechanical lifecycle/page/navigation seam. It receives metadata only and never writes to the audit journal. */
	observer?: BrowserSessionObserver;
	observerMaxQueued?: number;
	/** Per context/browser finalization stage. Defaults to 10s, so shutdown cannot wait forever on one Playwright resource. */
	finalizationTimeoutMs?: number;
}

export type SessionLifecycleState = "starting" | "open" | "closing" | "close-failed" | "closed";

export function transitionSessionLifecycle(current: SessionLifecycleState, next: SessionLifecycleState): SessionLifecycleState {
	const valid =
		(current === "starting" && (next === "open" || next === "close-failed")) ||
		(current === "open" && next === "closing") ||
		(current === "closing" && (next === "closed" || next === "close-failed")) ||
		(current === "close-failed" && next === "closing") ||
		(current === "closed" && next === "closed");
	if (!valid) throw new Error(`invalid session lifecycle transition: ${current} -> ${next}`);
	return next;
}

interface SessionEntry {
	info: SessionInfo;
	browser: BrowserSessionRuntime;
	state: SessionLifecycleState;
	emitEvent: (event: BrowserSessionEvent) => void;
	closePromise?: Promise<SessionFinalizationReport>;
	finalizationReport?: SessionFinalizationReport;
}

export class PlaywrightSessionRegistry implements SessionRegistry {
	private readonly sessions = new Map<string, SessionEntry>();
	/** Reserves a name synchronously before the launch await completes, so two concurrent create() calls for the same name (or racing the ceiling) can't both succeed. */
	private readonly pending = new Set<string>();
	private readonly launcher: BrowserLauncher;
	private readonly maxConcurrent: number;
	private readonly maxNameLength: number;
	private readonly now: () => number;
	private readonly downloadsBaseDir: string;
	private readonly logger?: Logger;
	private readonly observer?: BrowserSessionObserver;
	private readonly observerMaxQueued: number;
	private readonly finalizationTimeoutMs: number;

	constructor(opts: PlaywrightSessionRegistryOptions = {}) {
		this.launcher = opts.launcher ?? defaultBrowserLauncher(opts.logger);
		this.maxConcurrent = opts.maxConcurrent ?? SESSION_REGISTRY_MAX_CONCURRENT;
		this.maxNameLength = opts.maxNameLength ?? SESSION_NAME_MAX_LENGTH;
		this.now = opts.now ?? Date.now;
		this.downloadsBaseDir = opts.downloadsBaseDir ?? join(tmpdir(), "web-spider-downloads");
		this.logger = opts.logger;
		this.observer = opts.observer;
		this.observerMaxQueued = opts.observerMaxQueued ?? 100;
		this.finalizationTimeoutMs = opts.finalizationTimeoutMs ?? 10_000;
	}

	async create(name: string, opts: CreateSessionOptions = {}): Promise<SessionInfo> {
		if (!isValidSessionName(name, this.maxNameLength)) {
			throw new Error(
				`invalid session name ${JSON.stringify(name)} — use 1-${this.maxNameLength} letters, digits, "-", or "_", starting with a letter or digit`,
			);
		}
		if (this.sessions.has(name) || this.pending.has(name)) {
			throw new Error(`session already exists: "${name}"`);
		}
		const retainedRuntimes = [...this.sessions.values()].filter((entry) => entry.state !== "closed").length;
		if (retainedRuntimes + this.pending.size >= this.maxConcurrent) {
			throw new Error(`session limit reached (${this.maxConcurrent} concurrent sessions max) — close an existing session first`);
		}

		this.pending.add(name);
		const emitEvent = boundedObserverEmitter(this.observer, this.logger, this.observerMaxQueued);
		emitEvent({ kind: "lifecycle", sessionName: name, state: "starting" });
		try {
			const browser = await this.launcher({
				forceChromeChannel: opts.forceChromeChannel ?? false,
				headed: opts.headed ?? false,
				downloadsDir: join(this.downloadsBaseDir, name),
				sessionName: name,
				emitEvent,
			});
			try {
				// Create the initial page before publishing the session. Context-level
				// hooks are already installed by BrowserSessionRuntime, and a page
				// creation failure cannot leave a registered half-session behind.
				await browser.page();
			} catch (error) {
				try {
					await browser.close();
				} catch (closeError) {
					this.logger?.warn("session_browser_cleanup_failed", { error: String(closeError), stage: "initial-page" });
				}
				throw error;
			}
			const info = createSessionInfo(name, this.now());
			this.sessions.set(name, { info, browser, state: "open", emitEvent });
			emitEvent({ kind: "lifecycle", sessionName: name, state: "open" });
			return info;
		} finally {
			this.pending.delete(name);
		}
	}

	list(): SessionInfo[] {
		return [...this.sessions.values()]
			.filter((entry) => entry.state !== "closed")
			.map((entry) => (entry.state === "open" ? this.syncInfo(entry) : entry.info));
	}

	get(name: string): SessionInfo | undefined {
		const entry = this.sessions.get(name);
		return entry?.state === "open" ? this.syncInfo(entry) : undefined;
	}

	private openEntry(name: string): SessionEntry {
		const entry = this.sessions.get(name);
		if (!entry || entry.state !== "open") throw new Error(`no such open session: "${name}"`);
		return entry;
	}

	async page(name: string) {
		return this.openEntry(name).browser.page();
	}

	/** Refreshes the reported version to the active tab's own current value — correctly reflects a tab switch that happened via a preceding tabs(select)/tabs(new)/tabs(close) call in the same act(), not just "unchanged" as withTouchedActivity would report. */
	touchActivity(name: string): SessionInfo {
		const entry = this.openEntry(name);
		entry.info = { ...entry.info, snapshotVersion: entry.browser.activeSnapshotVersion(), lastActivityAt: this.now() };
		return entry.info;
	}

	/**
	 * Refreshes entry.info's reported snapshotVersion from the active tab's
	 * own tracked counter immediately — relying solely on the *next*
	 * touchActivity() call (as every other action does) would leave
	 * registry.get()/list() reporting stale info for the window between a
	 * tab operation and whatever act() call happens to follow it. Caught by
	 * a real walking-skeleton test: registry.get() briefly reported tab 0's
	 * version immediately after newTab() switched the active tab away.
	 */
	private syncInfo(entry: SessionEntry): SessionInfo {
		const snapshotVersion = entry.browser.activeSnapshotVersion();
		if (snapshotVersion !== entry.info.snapshotVersion) {
			entry.info = { ...entry.info, snapshotVersion, lastActivityAt: this.now() };
		}
		return entry.info;
	}

	private refreshInfo(entry: SessionEntry): void {
		entry.info = { ...this.syncInfo(entry), lastActivityAt: this.now() };
	}

	async listTabs(name: string): Promise<TabInfo[]> {
		const entry = this.openEntry(name);
		const tabs = await entry.browser.listTabs();
		this.refreshInfo(entry);
		return tabs;
	}

	async newTab(name: string, url?: string): Promise<TabInfo> {
		const entry = this.openEntry(name);
		const tab = await entry.browser.newTab(url);
		this.refreshInfo(entry);
		return tab;
	}

	async closeTab(name: string, tabIndex?: number): Promise<{ closedIndex: number; newActiveIndex: number | null }> {
		const entry = this.openEntry(name);
		const result = await entry.browser.closeTab(tabIndex);
		this.refreshInfo(entry);
		return result;
	}

	async selectTab(name: string, tabIndex: number): Promise<TabInfo> {
		const entry = this.openEntry(name);
		const tab = await entry.browser.selectTab(tabIndex);
		this.refreshInfo(entry);
		return tab;
	}

	async close(name: string): Promise<SessionFinalizationReport> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		if (entry.state === "closed") return entry.finalizationReport as SessionFinalizationReport;
		if (entry.state === "closing") return entry.closePromise as Promise<SessionFinalizationReport>;

		entry.state = transitionSessionLifecycle(entry.state, "closing");
		entry.emitEvent({ kind: "lifecycle", sessionName: name, state: "closing" });
		const closePromise = entry.browser.close({ timeoutMs: this.finalizationTimeoutMs }).then(
			(report) => {
				entry.state = transitionSessionLifecycle(entry.state, "closed");
				entry.info = withClosed(entry.info);
				entry.finalizationReport = report;
				entry.emitEvent({ kind: "lifecycle", sessionName: name, state: "closed" });
				return report;
			},
			(error) => {
				entry.state = transitionSessionLifecycle(entry.state, "close-failed");
				entry.emitEvent({ kind: "lifecycle", sessionName: name, state: "close-failed" });
				throw error;
			},
		);
		entry.closePromise = closePromise;
		try {
			return await closePromise;
		} finally {
			entry.closePromise = undefined;
		}
	}

	async closeAll(): Promise<void> {
		const names = [...this.sessions.entries()].filter(([, entry]) => entry.state !== "closed").map(([name]) => name);
		await Promise.allSettled(names.map((name) => this.close(name)));
	}
}
