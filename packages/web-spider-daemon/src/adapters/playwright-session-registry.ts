/**
 * Playwright-backed SessionRegistry — one owned Browser process per named
 * session (full-process isolation, agent-browser's model, not
 * browser.newContext()). See decision doc
 * decision-extend-web-spider-daemon-with-tmux-style-browser-se-ua4l and
 * research doc research-lightweight-browser-engine-options-for-the-session--0z7r
 * (default: Playwright's own chromium, letting chromium-headless-shell apply
 * automatically in headless mode — never force channel:"chrome" silently).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_MAX_CONSOLE_MESSAGES_TRACKED, SESSION_MAX_DOWNLOADS_TRACKED, SESSION_MAX_NETWORK_REQUESTS_TRACKED, SESSION_MAX_TABS, SESSION_NAME_MAX_LENGTH, SESSION_REGISTRY_MAX_CONCURRENT } from "../constants.ts";
import { createSessionInfo, isValidSessionName, type SessionInfo } from "../domain/session.ts";
import type { CreateSessionOptions, SessionPage, SessionRegistry, TabInfo } from "../ports/session-registry.ts";

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
export interface LaunchedBrowser {
	close(): Promise<void>;
	/** The currently active tab's persistent page. Lazily creates tab 0 on first call; returns the active tab's page on every subsequent call. */
	page(): Promise<SessionPage>;
	listTabs(): Promise<TabInfo[]>;
	newTab(url?: string): Promise<TabInfo>;
	closeTab(tabIndex?: number): Promise<{ closedIndex: number; newActiveIndex: number | null }>;
	selectTab(tabIndex: number): Promise<TabInfo>;
	/** The active tab's own tracked snapshotVersion, without changing it. 0 if no tab has ever been created. */
	activeSnapshotVersion(): number;
	/** Bumps and returns the active tab's own tracked version (called after a successful navigate on it). */
	bumpActiveSnapshotVersion(): number;
}

export type BrowserLauncher = (opts: { forceChromeChannel: boolean; downloadsDir: string }) => Promise<LaunchedBrowser>;

interface Tab {
	playwrightPage: PlaywrightPageLike;
	sessionPage: SessionPage;
	version: number;
}

function wrapPlaywrightBrowser(
	browser: { newPage: () => Promise<PlaywrightPageLike>; close: () => Promise<void> },
	downloadsDir: string,
): LaunchedBrowser {
	const tabs: Tab[] = [];
	let activeIndex = -1; // -1: no tab created yet
	let ensureFirstTabPromise: Promise<void> | undefined;

	// Idempotent and safe to call from any method — the first real access
	// (page(), listTabs(), etc.) lazily creates tab 0, exactly matching the
	// pre-multi-tab behavior for every caller that never touches tabs at all.
	function ensureFirstTab(): Promise<void> {
		if (!ensureFirstTabPromise) {
			ensureFirstTabPromise = browser.newPage().then((playwrightPage) => {
				tabs.push({ playwrightPage, sessionPage: wrapPlaywrightPage(playwrightPage, downloadsDir), version: 0 });
				activeIndex = 0;
			});
		}
		return ensureFirstTabPromise;
	}

	async function describeTab(index: number): Promise<TabInfo> {
		const tab = tabs[index] as Tab;
		return { index, url: tab.playwrightPage.url(), title: await tab.playwrightPage.title(), active: index === activeIndex };
	}

	return {
		close: () => browser.close(),
		page: async () => {
			await ensureFirstTab();
			return (tabs[activeIndex] as Tab).sessionPage;
		},
		listTabs: async () => {
			await ensureFirstTab();
			return Promise.all(tabs.map((_, index) => describeTab(index)));
		},
		newTab: async (url) => {
			await ensureFirstTab();
			if (tabs.length >= SESSION_MAX_TABS) throw new Error(`tab limit reached (${SESSION_MAX_TABS} tabs max per session) — close a tab first`);
			const playwrightPage = await browser.newPage();
			if (url !== undefined) await playwrightPage.goto(url);
			tabs.push({ playwrightPage, sessionPage: wrapPlaywrightPage(playwrightPage, downloadsDir), version: 0 });
			activeIndex = tabs.length - 1;
			return describeTab(activeIndex);
		},
		closeTab: async (tabIndex) => {
			await ensureFirstTab();
			const indexToClose = tabIndex ?? activeIndex;
			if (indexToClose < 0 || indexToClose >= tabs.length) throw new Error(`no such tab: ${indexToClose}`);
			await (tabs[indexToClose] as Tab).playwrightPage.close();
			tabs.splice(indexToClose, 1);
			let newActiveIndex: number | null;
			if (tabs.length === 0) {
				newActiveIndex = null;
			} else if (indexToClose === activeIndex) {
				newActiveIndex = Math.min(indexToClose, tabs.length - 1);
			} else if (indexToClose < activeIndex) {
				newActiveIndex = activeIndex - 1;
			} else {
				newActiveIndex = activeIndex;
			}
			activeIndex = newActiveIndex ?? -1;
			return { closedIndex: indexToClose, newActiveIndex };
		},
		selectTab: async (tabIndex) => {
			await ensureFirstTab();
			if (tabIndex < 0 || tabIndex >= tabs.length) throw new Error(`no such tab: ${tabIndex}`);
			activeIndex = tabIndex;
			return describeTab(activeIndex);
		},
		activeSnapshotVersion: () => tabs[activeIndex]?.version ?? 0,
		bumpActiveSnapshotVersion: () => {
			const tab = tabs[activeIndex] as Tab;
			tab.version += 1;
			return tab.version;
		},
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

interface PlaywrightDialogLike {
	accept(promptText?: string): Promise<void>;
	dismiss(): Promise<void>;
}

interface PlaywrightDownloadLike {
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

interface PlaywrightPageLike {
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
	/** Global keyboard press, not tied to any element — for keys like Escape with no natural target. Real Playwright API has no timeout option here (there's no element to wait for). */
	keyboard: { press(key: string): Promise<void> };
}

function wrapPlaywrightPage(page: PlaywrightPageLike, downloadsDir: string): SessionPage {
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
		if (policy?.accept) {
			await dialog.accept(policy.promptText);
		} else {
			await dialog.dismiss();
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
		await download.saveAs(path);
		downloads.push({ filename, path, url: download.url(), failure: await download.failure() });
		if (downloads.length > SESSION_MAX_DOWNLOADS_TRACKED) downloads.shift();
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
		networkRequests.push({ url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType() });
		if (networkRequests.length > SESSION_MAX_NETWORK_REQUESTS_TRACKED) networkRequests.shift();
	});

	return {
		goto: async (url, opts) => { await page.goto(url, opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined); },
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
		queryText: async (selector, opts) => {
			const texts = await page.locator(selector).allTextContents();
			return texts.map((t) => t.trim());
		},
		readTable: async (selector, opts) => {
			const timeoutOpt = opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined;
			return page.locator(selector).evaluate((el) => {
				// :scope-rooted so a nested table's own rows are never captured as
				// if they belonged to the matched (outer) table.
				const rows = el.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr");
				return Array.from(rows).map((row) => Array.from(row.querySelectorAll(":scope > td, :scope > th")).map((cell) => (cell.textContent ?? "").trim()));
			}, undefined, timeoutOpt);
		},
		snapshot: (opts) => {
			const ariaOpts = { depth: opts?.depth, boxes: opts?.boxes, mode: opts?.mode, timeout: opts?.timeoutMs };
			if (opts?.selector !== undefined) return page.locator(opts.selector).ariaSnapshot(ariaOpts);
			return page.ariaSnapshot(ariaOpts);
		},
		armDialogPolicy: async (policy) => { armedPolicy = policy; },
		listDownloads: async () => [...downloads],
		listConsoleMessages: async () => [...consoleMessages],
		listNetworkRequests: async () => [...networkRequests],
		evaluate: <T,>(script: string) => page.evaluate(script) as Promise<T>,
		screenshot: (opts) => {
			if (opts?.selector !== undefined) return page.locator(opts.selector).screenshot({ scale: opts.scale });
			return page.screenshot({ fullPage: opts?.fullPage, scale: opts?.scale });
		},
	};
}

/** Real launcher — lazily imports playwright-core so importing this module never requires the browser binary to be installed. */
export function defaultBrowserLauncher(): BrowserLauncher {
	return async ({ forceChromeChannel, downloadsDir }) => {
		const { chromium } = await import("playwright-core");
		const launchOpts = forceChromeChannel ? { channel: "chrome" as const, headless: true } : { headless: true };
		const browser = await chromium.launch(launchOpts);
		mkdirSync(downloadsDir, { recursive: true });
		return wrapPlaywrightBrowser(browser, downloadsDir);
	};
}

export interface PlaywrightSessionRegistryOptions {
	launcher?: BrowserLauncher;
	maxConcurrent?: number;
	maxNameLength?: number;
	now?: () => number;
	/** Base directory downloaded files are saved under, one subdirectory per session name. Defaults to a directory under the OS temp dir if omitted — callers wiring the real daemon should pass the real XDG-based path (see service.ts). */
	downloadsBaseDir?: string;
}

export class PlaywrightSessionRegistry implements SessionRegistry {
	private readonly sessions = new Map<string, { info: SessionInfo; browser: LaunchedBrowser }>();
	/** Reserves a name synchronously before the launch await completes, so two concurrent create() calls for the same name (or racing the ceiling) can't both succeed. */
	private readonly pending = new Set<string>();
	private readonly launcher: BrowserLauncher;
	private readonly maxConcurrent: number;
	private readonly maxNameLength: number;
	private readonly now: () => number;
	private readonly downloadsBaseDir: string;

	constructor(opts: PlaywrightSessionRegistryOptions = {}) {
		this.launcher = opts.launcher ?? defaultBrowserLauncher();
		this.maxConcurrent = opts.maxConcurrent ?? SESSION_REGISTRY_MAX_CONCURRENT;
		this.maxNameLength = opts.maxNameLength ?? SESSION_NAME_MAX_LENGTH;
		this.now = opts.now ?? Date.now;
		this.downloadsBaseDir = opts.downloadsBaseDir ?? join(tmpdir(), "web-spider-downloads");
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
		if (this.sessions.size + this.pending.size >= this.maxConcurrent) {
			throw new Error(`session limit reached (${this.maxConcurrent} concurrent sessions max) — close an existing session first`);
		}

		this.pending.add(name);
		try {
			const browser = await this.launcher({ forceChromeChannel: opts.forceChromeChannel ?? false, downloadsDir: join(this.downloadsBaseDir, name) });
			const info = createSessionInfo(name, this.now());
			this.sessions.set(name, { info, browser });
			return info;
		} finally {
			this.pending.delete(name);
		}
	}

	list(): SessionInfo[] {
		return [...this.sessions.values()].map((entry) => entry.info);
	}

	get(name: string): SessionInfo | undefined {
		return this.sessions.get(name)?.info;
	}

	async page(name: string) {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		return entry.browser.page();
	}

	/** Sources the reported version from the active tab's own tracked counter, bumping it — not withBumpedSnapshotVersion's session-wide "+1" (each tab tracks its own independently; see LaunchedBrowser's own doc comment). */
	bumpSnapshotVersion(name: string): SessionInfo {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		const version = entry.browser.bumpActiveSnapshotVersion();
		entry.info = { ...entry.info, snapshotVersion: version, lastActivityAt: this.now() };
		return entry.info;
	}

	/** Refreshes the reported version to the active tab's own current value — correctly reflects a tab switch that happened via a preceding tabs(select)/tabs(new)/tabs(close) call in the same act(), not just "unchanged" as withTouchedActivity would report. */
	touchActivity(name: string): SessionInfo {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
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
	private refreshInfo(entry: { info: SessionInfo; browser: LaunchedBrowser }): void {
		entry.info = { ...entry.info, snapshotVersion: entry.browser.activeSnapshotVersion(), lastActivityAt: this.now() };
	}

	async listTabs(name: string): Promise<TabInfo[]> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		const tabs = await entry.browser.listTabs();
		this.refreshInfo(entry);
		return tabs;
	}

	async newTab(name: string, url?: string): Promise<TabInfo> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		const tab = await entry.browser.newTab(url);
		this.refreshInfo(entry);
		return tab;
	}

	async closeTab(name: string, tabIndex?: number): Promise<{ closedIndex: number; newActiveIndex: number | null }> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		const result = await entry.browser.closeTab(tabIndex);
		this.refreshInfo(entry);
		return result;
	}

	async selectTab(name: string, tabIndex: number): Promise<TabInfo> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		const tab = await entry.browser.selectTab(tabIndex);
		this.refreshInfo(entry);
		return tab;
	}

	async close(name: string): Promise<void> {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		this.sessions.delete(name);
		await entry.browser.close();
	}

	async closeAll(): Promise<void> {
		const names = [...this.sessions.keys()];
		await Promise.allSettled(names.map((name) => this.close(name)));
	}
}
