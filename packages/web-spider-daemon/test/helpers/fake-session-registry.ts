import type { BrowserLauncher, LaunchedBrowser } from "../../src/adapters/playwright-session-registry.ts";
import type { SessionPage } from "../../src/ports/session-registry.ts";

export interface FakePageOptions {
	failGoto?: boolean;
	failClick?: boolean;
	failHover?: boolean;
	failPressKey?: boolean;
	failType?: boolean;
	failSelect?: boolean;
	failWaitFor?: boolean;
	failQueryText?: boolean;
	failReadTable?: boolean;
	failSnapshot?: boolean;
	failHandleDialog?: boolean;
	failListDownloads?: boolean;
	failListConsoleMessages?: boolean;
	failListNetworkRequests?: boolean;
	failEvaluate?: boolean;
	failScreenshot?: boolean;
	evaluateResult?: unknown;
	screenshotBytes?: Uint8Array;
	queryTextResult?: string[];
	readTableResult?: string[][];
	snapshotResult?: string;
	downloadsResult?: Array<{ filename: string; path: string; url: string; failure: string | null }>;
	consoleMessagesResult?: Array<{ type: string; text: string; timestamp: number }>;
	networkRequestsResult?: Array<{ url: string; method: string; status: number; resourceType: string }>;
}

export interface FakeSessionPage extends SessionPage {
	gotoCalls: Array<{ url: string; timeoutMs?: number }>;
	clickCalls: Array<{ selector: string; timeoutMs?: number }>;
	hoverCalls: Array<{ selector: string; timeoutMs?: number }>;
	pressKeyCalls: Array<{ key: string; selector?: string; timeoutMs?: number }>;
	typeCalls: Array<{ selector: string; text: string; timeoutMs?: number; clear?: boolean }>;
	selectCalls: Array<{ selector: string; target: { value?: string; label?: string }; timeoutMs?: number }>;
	waitForCalls: Array<{ target: { selector?: string; text?: string; loadState?: string }; timeoutMs?: number; state?: string }>;
	queryTextCalls: Array<{ selector: string; timeoutMs?: number }>;
	readTableCalls: Array<{ selector: string; timeoutMs?: number }>;
	snapshotCalls: Array<{ selector?: string; depth?: number; boxes?: boolean; mode?: "ai" | "default"; timeoutMs: number }>;
	armDialogPolicyCalls: Array<{ accept: boolean; promptText?: string }>;
	listDownloadsCallCount: number;
	listConsoleMessagesCallCount: number;
	listNetworkRequestsCallCount: number;
	evaluateCalls: string[];
	screenshotCallCount: number;
	screenshotCalls: Array<{ fullPage?: boolean; selector?: string; scale?: "css" | "device" }>;
}

export function createFakePage(opts: FakePageOptions = {}): FakeSessionPage {
	const gotoCalls: FakeSessionPage["gotoCalls"] = [];
	const clickCalls: FakeSessionPage["clickCalls"] = [];
	const hoverCalls: FakeSessionPage["hoverCalls"] = [];
	const pressKeyCalls: FakeSessionPage["pressKeyCalls"] = [];
	const typeCalls: FakeSessionPage["typeCalls"] = [];
	const selectCalls: FakeSessionPage["selectCalls"] = [];
	const waitForCalls: FakeSessionPage["waitForCalls"] = [];
	const queryTextCalls: FakeSessionPage["queryTextCalls"] = [];
	const readTableCalls: FakeSessionPage["readTableCalls"] = [];
	const snapshotCalls: FakeSessionPage["snapshotCalls"] = [];
	const armDialogPolicyCalls: FakeSessionPage["armDialogPolicyCalls"] = [];
	let listDownloadsCallCount = 0;
	let listConsoleMessagesCallCount = 0;
	let listNetworkRequestsCallCount = 0;
	const evaluateCalls: string[] = [];
	let screenshotCallCount = 0;
	const screenshotCalls: FakeSessionPage["screenshotCalls"] = [];
	return {
		gotoCalls,
		clickCalls,
		hoverCalls,
		pressKeyCalls,
		typeCalls,
		selectCalls,
		waitForCalls,
		queryTextCalls,
		readTableCalls,
		snapshotCalls,
		armDialogPolicyCalls,
		get listDownloadsCallCount() { return listDownloadsCallCount; },
		get listConsoleMessagesCallCount() { return listConsoleMessagesCallCount; },
		get listNetworkRequestsCallCount() { return listNetworkRequestsCallCount; },
		evaluateCalls,
		get screenshotCallCount() { return screenshotCallCount; },
		screenshotCalls,
		async goto(url, callOpts) {
			gotoCalls.push({ url, timeoutMs: callOpts?.timeoutMs });
			if (opts.failGoto) throw new Error("simulated navigation failure");
		},
		async click(selector, callOpts) {
			clickCalls.push({ selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failClick) throw new Error("simulated click failure: element not found");
		},
		async hover(selector, callOpts) {
			hoverCalls.push({ selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failHover) throw new Error("simulated hover failure: element not found");
		},
		async pressKey(key, callOpts) {
			pressKeyCalls.push({ key, selector: callOpts?.selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failPressKey) throw new Error("simulated pressKey failure");
		},
		async type(selector, text, callOpts) {
			typeCalls.push({ selector, text, timeoutMs: callOpts?.timeoutMs, clear: callOpts?.clear });
			if (opts.failType) throw new Error("simulated type failure: element not found");
		},
		async select(selector, target, callOpts) {
			selectCalls.push({ selector, target, timeoutMs: callOpts?.timeoutMs });
			if (opts.failSelect) throw new Error("simulated select failure: option not found");
		},
		async waitFor(target, callOpts) {
			waitForCalls.push({ target, timeoutMs: callOpts?.timeoutMs, state: callOpts?.state });
			if (opts.failWaitFor) throw new Error("simulated waitFor failure: timeout exceeded");
		},
		async queryText(selector, callOpts) {
			queryTextCalls.push({ selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failQueryText) throw new Error("simulated queryText failure: element not found");
			return opts.queryTextResult ?? [];
		},
		async readTable(selector, callOpts) {
			readTableCalls.push({ selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failReadTable) throw new Error("simulated readTable failure: element not found");
			return opts.readTableResult ?? [];
		},
		async snapshot(callOpts) {
			snapshotCalls.push(callOpts);
			if (opts.failSnapshot) throw new Error("simulated snapshot failure");
			return opts.snapshotResult ?? '- generic "root"';
		},
		async armDialogPolicy(policy) {
			armDialogPolicyCalls.push(policy);
			if (opts.failHandleDialog) throw new Error("simulated handleDialog failure");
		},
		async listDownloads() {
			listDownloadsCallCount++;
			if (opts.failListDownloads) throw new Error("simulated listDownloads failure");
			return opts.downloadsResult ?? [];
		},
		async listConsoleMessages() {
			listConsoleMessagesCallCount++;
			if (opts.failListConsoleMessages) throw new Error("simulated listConsoleMessages failure");
			return opts.consoleMessagesResult ?? [];
		},
		async listNetworkRequests() {
			listNetworkRequestsCallCount++;
			if (opts.failListNetworkRequests) throw new Error("simulated listNetworkRequests failure");
			return opts.networkRequestsResult ?? [];
		},
		async evaluate<T>(script: string) {
			evaluateCalls.push(script);
			if (opts.failEvaluate) throw new Error("simulated eval failure: ReferenceError: secretApiKey123 is not defined");
			return opts.evaluateResult as T;
		},
		async screenshot(callOpts) {
			screenshotCallCount++;
			screenshotCalls.push({ fullPage: callOpts?.fullPage, selector: callOpts?.selector, scale: callOpts?.scale });
			if (opts.failScreenshot) throw new Error("simulated screenshot failure");
			return opts.screenshotBytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		},
	};
}

export interface FakeLauncherOptions {
	delayMs?: number;
	failClose?: boolean;
	onLaunch?: (forceChromeChannel: boolean) => void;
	pageOptionsForSession?: (sessionIndex: number) => FakePageOptions;
}

/**
 * A launcher that never touches a real browser — fast, deterministic, and
 * lets tests control timing/failure/page behavior. Tracks multiple tabs per
 * session (mirroring PlaywrightSessionRegistry's own real adapter logic in
 * simplified form) so SessionService-level tests can exercise real tab-
 * switching semantics without a real browser.
 */
export function fakeLauncher(opts: FakeLauncherOptions = {}): {
	launcher: BrowserLauncher;
	launched: LaunchedBrowser[];
	pages: FakeSessionPage[];
} {
	const launched: LaunchedBrowser[] = [];
	const pages: FakeSessionPage[] = [];
	const launcher: BrowserLauncher = async ({ forceChromeChannel }) => {
		opts.onLaunch?.(forceChromeChannel);
		if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
		// Capture this session's index before pushing — page() is called later,
		// by which point launched.length would already have advanced past it.
		const sessionIndex = launched.length;
		interface FakeTab { page: FakeSessionPage; version: number; url: string }
		const tabs: FakeTab[] = [];
		let activeIndex = -1;
		const ensureFirstTab = () => {
			if (tabs.length === 0) {
				const page = createFakePage(opts.pageOptionsForSession?.(sessionIndex));
				pages.push(page);
				tabs.push({ page, version: 0, url: "about:blank" });
				activeIndex = 0;
			}
		};
		const describeTab = (index: number) => ({ index, url: (tabs[index] as FakeTab).url, title: "", active: index === activeIndex });
		const browser: LaunchedBrowser = {
			close: async () => {
				if (opts.failClose) throw new Error("simulated close failure");
			},
			page: async () => {
				ensureFirstTab();
				return (tabs[activeIndex] as FakeTab).page;
			},
			listTabs: async () => {
				ensureFirstTab();
				return tabs.map((_, index) => describeTab(index));
			},
			newTab: async (url) => {
				ensureFirstTab();
				const page = createFakePage(opts.pageOptionsForSession?.(sessionIndex));
				pages.push(page);
				tabs.push({ page, version: 0, url: url ?? "about:blank" });
				activeIndex = tabs.length - 1;
				return describeTab(activeIndex);
			},
			closeTab: async (tabIndex) => {
				ensureFirstTab();
				const indexToClose = tabIndex ?? activeIndex;
				if (indexToClose < 0 || indexToClose >= tabs.length) throw new Error(`no such tab: ${indexToClose}`);
				tabs.splice(indexToClose, 1);
				let newActiveIndex: number | null;
				if (tabs.length === 0) newActiveIndex = null;
				else if (indexToClose === activeIndex) newActiveIndex = Math.min(indexToClose, tabs.length - 1);
				else if (indexToClose < activeIndex) newActiveIndex = activeIndex - 1;
				else newActiveIndex = activeIndex;
				activeIndex = newActiveIndex ?? -1;
				return { closedIndex: indexToClose, newActiveIndex };
			},
			selectTab: async (tabIndex) => {
				ensureFirstTab();
				if (tabIndex < 0 || tabIndex >= tabs.length) throw new Error(`no such tab: ${tabIndex}`);
				activeIndex = tabIndex;
				return describeTab(activeIndex);
			},
			activeSnapshotVersion: () => tabs[activeIndex]?.version ?? 0,
			bumpActiveSnapshotVersion: () => {
				const tab = tabs[activeIndex] as FakeTab;
				tab.version += 1;
				return tab.version;
			},
		};
		launched.push(browser);
		return browser;
	};
	return { launcher, launched, pages };
}
