import type { BrowserLauncher, LaunchedBrowser } from "../../src/adapters/playwright-session-registry.ts";
import type { SessionPage } from "../../src/ports/session-registry.ts";

export interface FakePageOptions {
	failGoto?: boolean;
	failClick?: boolean;
	failType?: boolean;
	failSelect?: boolean;
	failWaitFor?: boolean;
	failEvaluate?: boolean;
	failScreenshot?: boolean;
	evaluateResult?: unknown;
	screenshotBytes?: Uint8Array;
}

export interface FakeSessionPage extends SessionPage {
	gotoCalls: Array<{ url: string; timeoutMs?: number }>;
	clickCalls: Array<{ selector: string; timeoutMs?: number }>;
	typeCalls: Array<{ selector: string; text: string; timeoutMs?: number; clear?: boolean }>;
	selectCalls: Array<{ selector: string; target: { value?: string; label?: string }; timeoutMs?: number }>;
	waitForCalls: Array<{ target: { selector?: string; text?: string; loadState?: string }; timeoutMs?: number; state?: string }>;
	evaluateCalls: string[];
	screenshotCallCount: number;
}

export function createFakePage(opts: FakePageOptions = {}): FakeSessionPage {
	const gotoCalls: FakeSessionPage["gotoCalls"] = [];
	const clickCalls: FakeSessionPage["clickCalls"] = [];
	const typeCalls: FakeSessionPage["typeCalls"] = [];
	const selectCalls: FakeSessionPage["selectCalls"] = [];
	const waitForCalls: FakeSessionPage["waitForCalls"] = [];
	const evaluateCalls: string[] = [];
	let screenshotCallCount = 0;
	return {
		gotoCalls,
		clickCalls,
		typeCalls,
		selectCalls,
		waitForCalls,
		evaluateCalls,
		get screenshotCallCount() { return screenshotCallCount; },
		async goto(url, callOpts) {
			gotoCalls.push({ url, timeoutMs: callOpts?.timeoutMs });
			if (opts.failGoto) throw new Error("simulated navigation failure");
		},
		async click(selector, callOpts) {
			clickCalls.push({ selector, timeoutMs: callOpts?.timeoutMs });
			if (opts.failClick) throw new Error("simulated click failure: element not found");
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
		async evaluate<T>(script: string) {
			evaluateCalls.push(script);
			if (opts.failEvaluate) throw new Error("simulated eval failure: ReferenceError: secretApiKey123 is not defined");
			return opts.evaluateResult as T;
		},
		async screenshot() {
			screenshotCallCount++;
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

/** A launcher that never touches a real browser — fast, deterministic, and lets tests control timing/failure/page behavior. */
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
		let page: FakeSessionPage | undefined;
		const browser: LaunchedBrowser = {
			close: async () => {
				if (opts.failClose) throw new Error("simulated close failure");
			},
			page: async () => {
				if (!page) {
					page = createFakePage(opts.pageOptionsForSession?.(sessionIndex));
					pages.push(page);
				}
				return page;
			},
		};
		launched.push(browser);
		return browser;
	};
	return { launcher, launched, pages };
}
