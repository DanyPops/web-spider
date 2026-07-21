#!/usr/bin/env bun
/**
 * UI-audit regression gate for agent-deck (~/Workspace/alignment/apps/agent-deck).
 * Closes the loop on the whole UI-audit toolkit epic: runs the layout and
 * contrast checkers against a *live* agent-deck dev server, across both
 * light and dark themes, and exits non-zero on any violation.
 *
 * Precondition: agent-deck's own dev server must already be running
 * (`npm run dev` from its directory — defaults to fixture data, no other
 * setup needed). This script does not start/stop that process itself —
 * single responsibility, and agent-deck's dev-server lifecycle belongs to
 * agent-deck, not to a script living in a different repository.
 *
 * Known, explicit limitation: the Observability tile renders its labels on
 * a WebGL <canvas> via sigma.js, not as DOM text. contrast-check.ts (like
 * any getComputedStyle()-based checker) cannot see canvas-rendered pixels
 * at all — checking that would need a materially different technique
 * (screen-position-aware pixel sampling of the canvas's rendered output),
 * which is not implemented here. This script therefore checks every
 * real DOM text element in the Conversation tile (and the app chrome), and
 * documents rather than silently skips the canvas gap in its own output.
 *
 * Usage:
 *   bun scripts/audit-agent-deck.ts [--base-url http://localhost:5183]
 */
import { defaultBrowserLauncher, PlaywrightSessionRegistry } from "../src/adapters/playwright-session-registry.ts";
import { checkContrast, type ContrastCheckResult } from "../src/contrast-check.ts";
import { checkLayout, type LayoutCheckResult } from "../src/layout-check.ts";
import type { SessionPage } from "../src/ports/session-registry.ts";

const MESSAGE_BUBBLE_SELECTOR = "div.rounded-lg.px-3.py-2";
const TOOL_CALL_CARD_SELECTOR = "details.rounded-lg";

/** Real DOM text elements present once the fixture session has rendered — deliberately excludes the Observability tile's canvas-rendered labels; see the module doc comment above. */
const CONTRAST_SELECTORS = [
	"h1",
	"#theme-toggle",
	".dv-default-tab-content",
	MESSAGE_BUBBLE_SELECTOR,
	"details.rounded-lg summary",
	"details.rounded-lg summary code",
	"details.rounded-lg pre",
	"details.rounded-lg p",
	".italic", // turn-marker ("Assistant is using N tools…") — present in the default fixture
];

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function setTheme(page: SessionPage, target: Theme): Promise<void> {
	const label = target === "light" ? "Theme: Light" : "Theme: Dark";
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await page.evaluate<string>("document.getElementById('theme-toggle')?.textContent ?? ''");
		if (current.trim() === label) return;
		await page.click("#theme-toggle");
	}
	throw new Error(`could not reach theme "${target}" after 3 toggle clicks — is #theme-toggle present?`);
}

interface ThemeAuditResult {
	theme: Theme;
	layout: LayoutCheckResult;
	contrast: ContrastCheckResult;
}

async function auditTheme(page: SessionPage, theme: Theme): Promise<ThemeAuditResult> {
	await setTheme(page, theme);
	const layout = await checkLayout(page, {
		selectors: [MESSAGE_BUBBLE_SELECTOR, TOOL_CALL_CARD_SELECTOR],
		properties: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
	});
	const contrast = await checkContrast(page, CONTRAST_SELECTORS);
	return { theme, layout, contrast };
}

function report(results: ThemeAuditResult[]): boolean {
	let clean = true;
	for (const { theme, layout, contrast } of results) {
		console.log(`\n=== ${theme} theme ===`);
		if (layout.consistent) {
			console.log("  layout:   OK — message bubble and tool-call card padding match");
		} else {
			clean = false;
			console.log("  layout:   VIOLATION");
			for (const m of layout.mismatches) {
				console.log(`    ${m.property}: ${m.values.map((v) => `${v.selector}=${v.value}px`).join(" vs ")} (Δ${m.deltaPx}px)`);
			}
		}
		if (contrast.passed) {
			console.log("  contrast: OK — every checked DOM text element meets its WCAG threshold");
		} else {
			clean = false;
			console.log("  contrast: VIOLATION");
			for (const v of contrast.violations) {
				console.log(`    ${v.selector} ("${v.textSnippet}"): ratio ${v.ratio.toFixed(2)}:1, required ${v.required}:1${v.isLargeText ? " (large text)" : ""}`);
			}
		}
	}
	console.log(
		"\nNote: the Observability tile's sigma.js labels render on a WebGL <canvas>, not as DOM text — "
		+ "this contrast check cannot see them; see this script's module doc comment.",
	);
	return clean;
}

async function main(): Promise<void> {
	const baseUrlFlagIndex = process.argv.indexOf("--base-url");
	const baseUrl = baseUrlFlagIndex >= 0 ? process.argv[baseUrlFlagIndex + 1] : (process.env.AGENT_DECK_URL ?? "http://localhost:5183");
	if (!baseUrl) {
		console.error("usage: audit-agent-deck.ts [--base-url URL]  (or set AGENT_DECK_URL)");
		process.exit(2);
	}

	try {
		await fetch(baseUrl);
	} catch {
		console.error(
			`Could not reach ${baseUrl} — is agent-deck's dev server running?\n`
			+ "Start it first: (cd ~/Workspace/alignment/apps/agent-deck && npm run dev)",
		);
		process.exit(1);
	}

	const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher() });
	await registry.create("agent-deck-audit");
	try {
		const page = await registry.page("agent-deck-audit");
		await page.goto(baseUrl);

		const results: ThemeAuditResult[] = [];
		for (const theme of THEMES) results.push(await auditTheme(page, theme));

		const clean = report(results);
		process.exit(clean ? 0 : 1);
	} finally {
		await registry.close("agent-deck-audit");
	}
}

await main();
