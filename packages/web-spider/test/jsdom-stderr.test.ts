/**
 * Regression tests for WBS-BUG-2:
 * JSDOM emits "Could not parse CSS stylesheet" to stderr on every page parse.
 *
 * Root cause: parseDom() passes no virtualConsole to JSDOM. The JSDOM default
 * creates a VirtualConsole with .forwardTo(console), so every jsdomError event
 * (including CSS parse failures) reaches console.error → process.stderr → raw
 * terminal, corrupting the Pi Agent TUI.
 *
 * These tests:
 *   1. Verify the EXACT path JSDOM uses: VirtualConsole → console.error
 *   2. Assert that parseDom() and buildTree() never call console.error (or write
 *      to process.stderr) regardless of how broken the CSS in the page is.
 *   3. Verify that a silent VirtualConsole is the correct fix.
 *
 * They do NOT make real network requests.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDom } from "../src/parse.js";
import { buildTree } from "../src/tree.js";

// ---------------------------------------------------------------------------
// Fixtures — HTML with CSS that actually triggers JSDOM jsdomError events
// ---------------------------------------------------------------------------

/**
 * HTML with genuinely unparseable CSS (verified to trigger "Could not parse CSS
 * stylesheet" from csstree via JSDOM's jsdomError event).
 * Modern CSS features (nesting, @layer, etc.) do NOT trigger errors in JSDOM 29;
 * only truly malformed syntax does.
 */
const HTML_BROKEN_CSS = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Broken CSS test</title>
  <style>this is not valid css at all {{{ broken</style>
</head>
<body>
  <article>
    <h1>Title</h1>
    <p>Body paragraph with enough words that Readability would be happy to extract this content.</p>
    <p>Second paragraph for good measure and more content to ensure extraction works correctly.</p>
  </article>
</body>
</html>`;

/**
 * HTML with an unknown at-rule that causes csstree to emit a parse error.
 * Must use the specific syntax variant `@-random-unknown { ... {{{ }` that
 * actually fails csstree's parser (verified with JSDOM 29 / csstree 3).
 */
const HTML_UNKNOWN_AT_RULE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Unknown at-rule test</title>
  <style>@-random-unknown { bad css {{{ }</style>
  <style>body { color: red; }</style>
</head>
<body>
  <article>
    <h1>Title</h1>
    <p>Body content here with sufficient words to pass the chunker minimum threshold.</p>
    <p>More content to ensure reliable extraction by Mozilla Readability.</p>
  </article>
</body>
</html>`;

/**
 * HTML combining multiple CSS error triggers to simulate a real production page
 * with inline vendor styles that confuse JSDOM's csstree-based CSS parser.
 */
const HTML_MULTIPLE_CSS_ERRORS = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Multiple CSS errors</title>
  <style>this is broken {{{ very broken css that no parser understands at all</style>
  <style>@-random-unknown { bad css {{{ }</style>
</head>
<body>
  <article>
    <h1>Title</h1>
    <p>First paragraph content for testing without network access needed.</p>
    <p>Second paragraph adds more text to ensure content extraction succeeds.</p>
  </article>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Confirms that a given HTML string actually triggers JSDOM jsdomError events
 * (i.e., is a valid test fixture for this bug). Fails the test if it doesn't.
 */
function assertHtmlTriggersCssError(html: string, url = "https://example.com"): void {
	const vc = new VirtualConsole();
	let errorCount = 0;
	vc.on("jsdomError", (e) => {
		if (e.type === "css-parsing") errorCount++;
	});
	new JSDOM(html, { url, virtualConsole: vc });
	if (errorCount === 0) {
		throw new Error(
			`Test fixture validation failed: the HTML did not trigger any jsdomError events. ` +
				`Update the fixture to include CSS that csstree cannot parse.`,
		);
	}
}

/**
 * Spy on console.error and process.stderr.write and collect all writes.
 * JSDOM's default VirtualConsole uses console.error (via forwardTo(console))
 * so we must spy at both levels.
 */
function captureOutput() {
	const consoleErrorCalls: string[] = [];
	const stderrWrites: string[] = [];

	const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
		consoleErrorCalls.push(args.map(String).join(" "));
	});

	const stderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown, ...rest: unknown[]): boolean => {
			stderrWrites.push(String(chunk));
			const cb = rest.find((a) => typeof a === "function") as
				| ((err?: Error | null) => void)
				| undefined;
			if (cb) cb();
			return true;
		});

	return {
		consoleErrorCalls,
		stderrWrites,
		restore() {
			consoleErrorSpy.mockRestore();
			stderrSpy.mockRestore();
		},
		/** All captured output combined — CSS errors can arrive on either channel. */
		get allOutput() {
			return [...consoleErrorCalls, ...stderrWrites];
		},
	};
}

// ---------------------------------------------------------------------------
// Fixture validation — ensures our test HTML actually triggers JSDOM errors
// ---------------------------------------------------------------------------

describe("test fixture validation", () => {
	it("HTML_BROKEN_CSS triggers a JSDOM css-parsing jsdomError", () => {
		expect(() => assertHtmlTriggersCssError(HTML_BROKEN_CSS)).not.toThrow();
	});

	it("HTML_UNKNOWN_AT_RULE triggers a JSDOM css-parsing jsdomError", () => {
		expect(() => assertHtmlTriggersCssError(HTML_UNKNOWN_AT_RULE)).not.toThrow();
	});

	it("HTML_MULTIPLE_CSS_ERRORS triggers at least one JSDOM css-parsing jsdomError", () => {
		expect(() => assertHtmlTriggersCssError(HTML_MULTIPLE_CSS_ERRORS)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Bug documentation: what the DEFAULT JSDOM does (no virtualConsole)
//
// These tests document the bug: without the fix, console.error IS called.
// They will start FAILING once parseDom() passes a silent VirtualConsole.
// ---------------------------------------------------------------------------

describe("WBS-BUG-2 — bug documentation: default JSDOM leaks CSS errors to console.error", () => {
	it("new JSDOM(html) WITHOUT silent virtualConsole calls console.error on broken CSS", () => {
		const cap = captureOutput();
		try {
			// Directly test JSDOM default behaviour (not parseDom — this documents
			// what parseDom is CURRENTLY doing incorrectly).
			new JSDOM(HTML_BROKEN_CSS, { url: "https://example.com" }); // no virtualConsole!
		} finally {
			cap.restore();
		}
		// BUG: console.error WAS called with the CSS error.
		// This test will FAIL after parseDom is fixed (because the fix means
		// parseDom no longer passes no virtualConsole, but raw JSDOM still has the bug).
		expect(cap.consoleErrorCalls.length).toBeGreaterThan(0);
		expect(
			cap.consoleErrorCalls.some((m) => m.toLowerCase().includes("css") || m.toLowerCase().includes("parse")),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseDom — the primary path (used by spider() for all views)
// ---------------------------------------------------------------------------

describe("parseDom — no console.error / stderr output (fix contract)", () => {
	let cap: ReturnType<typeof captureOutput>;

	beforeEach(() => {
		cap = captureOutput();
	});

	afterEach(() => {
		cap.restore();
	});

	it("does not call console.error when parsing a page with broken CSS (HTML_BROKEN_CSS)", () => {
		parseDom(HTML_BROKEN_CSS, "https://example.com/page");
		expect(cap.consoleErrorCalls).toHaveLength(0);
	});

	it("does not call console.error when parsing a page with an unknown at-rule", () => {
		parseDom(HTML_UNKNOWN_AT_RULE, "https://example.com/page");
		expect(cap.consoleErrorCalls).toHaveLength(0);
	});

	it("does not call console.error when parsing a page with multiple CSS errors", () => {
		parseDom(HTML_MULTIPLE_CSS_ERRORS, "https://example.com/page");
		expect(cap.consoleErrorCalls).toHaveLength(0);
	});

	it("does not write to process.stderr when parsing a page with broken CSS", () => {
		parseDom(HTML_BROKEN_CSS, "https://example.com/page");
		expect(cap.stderrWrites).toHaveLength(0);
	});

	it("does not write to process.stderr when parsing a page with multiple CSS errors", () => {
		parseDom(HTML_MULTIPLE_CSS_ERRORS, "https://example.com/page");
		expect(cap.stderrWrites).toHaveLength(0);
	});

	it("produces zero combined output across console.error + process.stderr for any broken CSS", () => {
		parseDom(HTML_BROKEN_CSS, "https://example.com/page");
		parseDom(HTML_UNKNOWN_AT_RULE, "https://example.com/page");
		parseDom(HTML_MULTIPLE_CSS_ERRORS, "https://example.com/page");
		expect(cap.allOutput).toHaveLength(0);
	});

	it("output contains no 'CSS' or 'parse' keywords from any parse call", () => {
		parseDom(HTML_BROKEN_CSS, "https://example.com/page");
		parseDom(HTML_UNKNOWN_AT_RULE, "https://example.com/page");
		const combined = cap.allOutput.join("\n");
		expect(combined).not.toMatch(/css/i);
		expect(combined).not.toMatch(/parse/i);
		expect(combined).not.toMatch(/stylesheet/i);
	});

	it("still returns a valid Document — suppression does not break parsing", () => {
		const doc = parseDom(HTML_BROKEN_CSS, "https://example.com/page");
		expect(doc.title).toBe("Broken CSS test");
		expect(doc.querySelector("article")).not.toBeNull();
		expect(doc.querySelector("h1")?.textContent).toBe("Title");
	});

	it("returns a Document with correct URL context even with broken CSS", () => {
		const doc = parseDom(HTML_UNKNOWN_AT_RULE, "https://example.com/page");
		expect(doc.title).toBe("Unknown at-rule test");
		expect(doc.querySelectorAll("p")).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// buildTree — secondary path (used by spider(url, { view: "tree" }))
// ---------------------------------------------------------------------------

describe("buildTree — no console.error / stderr output (fix contract)", () => {
	let cap: ReturnType<typeof captureOutput>;

	beforeEach(() => {
		cap = captureOutput();
	});

	afterEach(() => {
		cap.restore();
	});

	it("does not call console.error when building a tree from article HTML with broken CSS", () => {
		// buildTree receives article HTML (post-Readability). CSS tags may survive extraction.
		const articleHtml = `<article>
      <style>this is not valid css at all {{{ broken</style>
      <h1>Title</h1>
      <p>Paragraph one with enough words for testing.</p>
      <p>Paragraph two with even more words to be safe here.</p>
    </article>`;
		buildTree(articleHtml, "https://example.com/page");
		expect(cap.consoleErrorCalls).toHaveLength(0);
		expect(cap.stderrWrites).toHaveLength(0);
	});

	it("does not call console.error when article HTML has an unknown at-rule", () => {
		const articleHtml = `<article>
      <style>@-random-unknown { bad css {{{ }</style>
      <h1>Title</h1>
      <p>Body content here.</p>
    </article>`;
		buildTree(articleHtml, "https://example.com/page");
		expect(cap.allOutput).toHaveLength(0);
	});

	it("returns a non-null tree node even when CSS parse errors are silenced", () => {
		const articleHtml = `<article>
      <style>this is broken {{{ css</style>
      <h1>Title</h1>
      <p>Body content with enough words.</p>
    </article>`;
		const tree = buildTree(articleHtml, "https://example.com/page");
		expect(tree).not.toBeNull();
		expect(tree.tag).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Repeated calls — no accumulating noise across multiple parseDom calls
// ---------------------------------------------------------------------------

describe("parseDom — no stderr across repeated calls with broken CSS", () => {
	it("produces zero console.error calls across 10 consecutive parseDom calls with broken CSS", () => {
		const cap = captureOutput();
		try {
			for (let i = 0; i < 10; i++) {
				parseDom(HTML_BROKEN_CSS, `https://example.com/page-${i}`);
			}
			expect(cap.consoleErrorCalls).toHaveLength(0);
		} finally {
			cap.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Fix verification: a silent VirtualConsole is the correct remedy
// ---------------------------------------------------------------------------

describe("silent VirtualConsole is the correct fix (reference implementation)", () => {
	it("new JSDOM with a silent VirtualConsole produces zero console.error calls on broken CSS", () => {
		const cap = captureOutput();
		try {
			const silentConsole = new VirtualConsole(); // no forwardTo() call → events silently dropped
			new JSDOM(HTML_BROKEN_CSS, { url: "https://example.com", virtualConsole: silentConsole });
			new JSDOM(HTML_UNKNOWN_AT_RULE, { url: "https://example.com", virtualConsole: silentConsole });
		} finally {
			cap.restore();
		}
		expect(cap.allOutput).toHaveLength(0);
	});

	it("silent VirtualConsole still allows the DOM to parse correctly", () => {
		const silentConsole = new VirtualConsole();
		const dom = new JSDOM(HTML_BROKEN_CSS, { url: "https://example.com", virtualConsole: silentConsole });
		expect(dom.window.document.title).toBe("Broken CSS test");
		expect(dom.window.document.querySelector("article")).not.toBeNull();
	});

	it("a shared silent VirtualConsole can be reused safely across multiple JSDOM instances", () => {
		const cap = captureOutput();
		const silentConsole = new VirtualConsole();
		try {
			for (let i = 0; i < 5; i++) {
				new JSDOM(HTML_MULTIPLE_CSS_ERRORS, { url: `https://example.com/${i}`, virtualConsole: silentConsole });
			}
		} finally {
			cap.restore();
		}
		expect(cap.allOutput).toHaveLength(0);
	});
});
