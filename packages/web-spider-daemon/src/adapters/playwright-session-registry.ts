/**
 * Playwright-backed SessionRegistry — one owned Browser process per named
 * session (full-process isolation, agent-browser's model, not
 * browser.newContext()). See decision doc
 * decision-extend-web-spider-daemon-with-tmux-style-browser-se-ua4l and
 * research doc research-lightweight-browser-engine-options-for-the-session--0z7r
 * (default: Playwright's own chromium, letting chromium-headless-shell apply
 * automatically in headless mode — never force channel:"chrome" silently).
 */
import { SESSION_NAME_MAX_LENGTH, SESSION_REGISTRY_MAX_CONCURRENT } from "../constants.ts";
import { createSessionInfo, isValidSessionName, withBumpedSnapshotVersion, withTouchedActivity, type SessionInfo } from "../domain/session.ts";
import type { CreateSessionOptions, SessionPage, SessionRegistry } from "../ports/session-registry.ts";

/** The minimal surface this module needs from a launched browser. */
export interface LaunchedBrowser {
	close(): Promise<void>;
	/** Lazily creates the session's one persistent page on first call; returns the same page on every subsequent call. */
	page(): Promise<SessionPage>;
}

export type BrowserLauncher = (opts: { forceChromeChannel: boolean }) => Promise<LaunchedBrowser>;

function wrapPlaywrightBrowser(browser: { newPage: () => Promise<PlaywrightPageLike>; close: () => Promise<void> }): LaunchedBrowser {
	let pagePromise: Promise<SessionPage> | undefined;
	return {
		close: () => browser.close(),
		page: () => {
			if (!pagePromise) {
				pagePromise = browser.newPage().then((playwrightPage) => wrapPlaywrightPage(playwrightPage));
			}
			return pagePromise;
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
	/** Used only to position the cursor at the end of existing content before an appending (clear:false) type. */
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

interface PlaywrightPageLike {
	goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
	click(selector: string, opts?: { timeout?: number }): Promise<void>;
	locator(selector: string): PlaywrightLocatorLike;
	/** Text-content locator (Playwright's own escaping, not a hand-built :text() selector string). */
	getByText(text: string): PlaywrightLocatorLike;
	waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", opts?: { timeout?: number }): Promise<void>;
	evaluate(script: string): Promise<unknown>;
	screenshot(opts?: { fullPage?: boolean; scale?: "css" | "device" }): Promise<Uint8Array>;
	ariaSnapshot(opts?: { depth?: number; boxes?: boolean; mode?: "ai" | "default"; timeout?: number }): Promise<string>;
	on(event: "dialog", handler: (dialog: PlaywrightDialogLike) => void | Promise<void>): void;
}

function wrapPlaywrightPage(page: PlaywrightPageLike): SessionPage {
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

	return {
		goto: async (url, opts) => { await page.goto(url, opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined); },
		click: (selector, opts) => page.click(selector, opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined),
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
		evaluate: <T,>(script: string) => page.evaluate(script) as Promise<T>,
		screenshot: (opts) => {
			if (opts?.selector !== undefined) return page.locator(opts.selector).screenshot({ scale: opts.scale });
			return page.screenshot({ fullPage: opts?.fullPage, scale: opts?.scale });
		},
	};
}

/** Real launcher — lazily imports playwright-core so importing this module never requires the browser binary to be installed. */
export function defaultBrowserLauncher(): BrowserLauncher {
	return async ({ forceChromeChannel }) => {
		const { chromium } = await import("playwright-core");
		const launchOpts = forceChromeChannel ? { channel: "chrome" as const, headless: true } : { headless: true };
		const browser = await chromium.launch(launchOpts);
		return wrapPlaywrightBrowser(browser);
	};
}

export interface PlaywrightSessionRegistryOptions {
	launcher?: BrowserLauncher;
	maxConcurrent?: number;
	maxNameLength?: number;
	now?: () => number;
}

export class PlaywrightSessionRegistry implements SessionRegistry {
	private readonly sessions = new Map<string, { info: SessionInfo; browser: LaunchedBrowser }>();
	/** Reserves a name synchronously before the launch await completes, so two concurrent create() calls for the same name (or racing the ceiling) can't both succeed. */
	private readonly pending = new Set<string>();
	private readonly launcher: BrowserLauncher;
	private readonly maxConcurrent: number;
	private readonly maxNameLength: number;
	private readonly now: () => number;

	constructor(opts: PlaywrightSessionRegistryOptions = {}) {
		this.launcher = opts.launcher ?? defaultBrowserLauncher();
		this.maxConcurrent = opts.maxConcurrent ?? SESSION_REGISTRY_MAX_CONCURRENT;
		this.maxNameLength = opts.maxNameLength ?? SESSION_NAME_MAX_LENGTH;
		this.now = opts.now ?? Date.now;
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
			const browser = await this.launcher({ forceChromeChannel: opts.forceChromeChannel ?? false });
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

	bumpSnapshotVersion(name: string): SessionInfo {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		entry.info = withBumpedSnapshotVersion(entry.info, this.now());
		return entry.info;
	}

	touchActivity(name: string): SessionInfo {
		const entry = this.sessions.get(name);
		if (!entry) throw new Error(`no such session: "${name}"`);
		entry.info = withTouchedActivity(entry.info, this.now());
		return entry.info;
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
