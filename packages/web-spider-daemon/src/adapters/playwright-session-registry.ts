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
interface PlaywrightLocatorLike {
	fill(value: string, opts?: { timeout?: number }): Promise<void>;
	pressSequentially(text: string, opts?: { timeout?: number }): Promise<void>;
	selectOption(target: { value: string } | { label: string }, opts?: { timeout?: number }): Promise<string[]>;
	/** Used only to position the cursor at the end of existing content before an appending (clear:false) type. */
	press(key: string, opts?: { timeout?: number }): Promise<void>;
}

interface PlaywrightPageLike {
	goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
	click(selector: string, opts?: { timeout?: number }): Promise<void>;
	locator(selector: string): PlaywrightLocatorLike;
	evaluate(script: string): Promise<unknown>;
	screenshot(): Promise<Uint8Array>;
}

function wrapPlaywrightPage(page: PlaywrightPageLike): SessionPage {
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
		evaluate: <T,>(script: string) => page.evaluate(script) as Promise<T>,
		screenshot: () => page.screenshot(),
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
