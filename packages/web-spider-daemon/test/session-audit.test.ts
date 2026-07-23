import { describe, expect, test } from "bun:test";
import { boundedJournalError, isSessionAction, journalTargetFor, sanitizeUrlForJournal, SESSION_ACTIONS } from "../src/domain/session-audit.ts";

describe("sanitizeUrlForJournal", () => {
	test("redacts sensitive query parameter values, keeps the rest of the URL intact", () => {
		const sanitized = sanitizeUrlForJournal("https://example.com/path?token=abc123&q=hello&api_key=xyz");
		expect(sanitized).toContain("token=%5Bredacted%5D");
		expect(sanitized).toContain("api_key=%5Bredacted%5D");
		expect(sanitized).toContain("q=hello");
		expect(sanitized).not.toContain("abc123");
		expect(sanitized).not.toContain("xyz");
	});

	test("strips userinfo and hash fragments", () => {
		const sanitized = sanitizeUrlForJournal("https://user:pass@example.com/path#secret-fragment");
		expect(sanitized).not.toContain("user");
		expect(sanitized).not.toContain("pass");
		expect(sanitized).not.toContain("secret-fragment");
	});

	test("rejects non-http(s) protocols with a fixed placeholder", () => {
		expect(sanitizeUrlForJournal("file:///etc/passwd")).toBe("<non-http-url>");
		expect(sanitizeUrlForJournal("javascript:alert(1)")).toBe("<non-http-url>");
	});

	test("returns a fixed placeholder for an unparseable URL rather than throwing", () => {
		expect(sanitizeUrlForJournal("not a url at all")).toBe("<invalid-url>");
	});

	test("bounds overall length", () => {
		const long = `https://example.com/${"a".repeat(1_000)}`;
		expect(sanitizeUrlForJournal(long).length).toBeLessThanOrEqual(500);
	});
});

describe("SESSION_ACTIONS / isSessionAction — the single source of truth service.ts and cli.ts both validate against", () => {
	test("accepts every currently-defined action", () => {
		for (const action of SESSION_ACTIONS) expect(isSessionAction(action)).toBe(true);
	});

	test("rejects an unknown action name", () => {
		expect(isSessionAction("bogus")).toBe(false);
	});

	test("rejects undefined (a missing --action flag)", () => {
		expect(isSessionAction(undefined)).toBe(false);
	});
});

describe("journalTargetFor", () => {
	test("navigate: the sanitized URL", () => {
		expect(journalTargetFor("navigate", { url: "https://example.com/x" })).toBe("https://example.com/x");
	});

	test("click: the selector, bounded", () => {
		expect(journalTargetFor("click", { selector: "#submit" })).toBe("#submit");
		expect(journalTargetFor("click", { selector: "a".repeat(1_000) }).length).toBeLessThanOrEqual(200);
	});

	test("type: the selector, bounded — never the typed text", () => {
		expect(journalTargetFor("type", { selector: "#search" })).toBe("#search");
		expect(journalTargetFor("type", { selector: "a".repeat(1_000) }).length).toBeLessThanOrEqual(200);
	});

	test("select: the selector, bounded", () => {
		expect(journalTargetFor("select", { selector: "#workgroup" })).toBe("#workgroup");
		expect(journalTargetFor("select", { selector: "a".repeat(1_000) }).length).toBeLessThanOrEqual(200);
	});

	test("waitFor: the selector, bounded, when waiting on a selector", () => {
		expect(journalTargetFor("waitFor", { selector: "#results" })).toBe("#results");
	});

	test("waitFor: a load-state placeholder including the actual state name (not sensitive)", () => {
		expect(journalTargetFor("waitFor", { loadState: "networkidle" })).toBe("<load-state:networkidle>");
	});

	test("waitFor: a fixed placeholder for a text wait — never the waited-for text itself", () => {
		expect(journalTargetFor("waitFor", { text: "super-secret-marker" })).toBe("<text-wait>");
	});

	test("queryText: the selector, bounded — never the extracted text", () => {
		expect(journalTargetFor("queryText", { selector: "li" })).toBe("li");
		expect(journalTargetFor("queryText", { selector: "a".repeat(1_000) }).length).toBeLessThanOrEqual(200);
	});

	test("readTable: the selector, bounded — never the extracted rows", () => {
		expect(journalTargetFor("readTable", { selector: "table" })).toBe("table");
	});

	test("snapshot: the fixed placeholder for a whole-page snapshot", () => {
		expect(journalTargetFor("snapshot", {})).toBe("<snapshot>");
	});

	test("snapshot: the selector, bounded, for an element/subtree-scoped snapshot", () => {
		expect(journalTargetFor("snapshot", { selector: "nav" })).toBe("nav");
	});

	test("handleDialog: a fixed placeholder for accept, distinct from dismiss — never the promptText", () => {
		expect(journalTargetFor("handleDialog", { accept: true })).toBe("<dialog:accept>");
		expect(journalTargetFor("handleDialog", { accept: false })).toBe("<dialog:dismiss>");
	});

	test("downloads: always the fixed placeholder — a read of already-captured metadata", () => {
		expect(journalTargetFor("downloads", {})).toBe("<downloads>");
	});

	test("hover: the selector, bounded", () => {
		expect(journalTargetFor("hover", { selector: "#menu" })).toBe("#menu");
	});

	test("pressKey: the key name, verbatim (never sensitive)", () => {
		expect(journalTargetFor("pressKey", { key: "Enter" })).toBe("Enter");
	});

	test("consoleMessages: always the fixed placeholder", () => {
		expect(journalTargetFor("consoleMessages", {})).toBe("<console-messages>");
	});

	test("networkRequests: always the fixed placeholder", () => {
		expect(journalTargetFor("networkRequests", {})).toBe("<network-requests>");
	});

	test("tabs: the tabOperation, and the tabIndex when present — neither is sensitive", () => {
		expect(journalTargetFor("tabs", { tabOperation: "list" })).toBe("<tabs:list>");
		expect(journalTargetFor("tabs", { tabOperation: "select", tabIndex: 2 })).toBe("<tabs:select:2>");
	});

	test("eval: always the fixed placeholder, regardless of any script-shaped input", () => {
		expect(journalTargetFor("eval", {})).toBe("<script>");
	});

	test("screenshot: the fixed placeholder for a whole-page/viewport capture", () => {
		expect(journalTargetFor("screenshot", {})).toBe("<screenshot>");
	});

	test("screenshot: the selector, bounded, for an element-scoped capture", () => {
		expect(journalTargetFor("screenshot", { selector: "#chart" })).toBe("#chart");
	});
});

describe("boundedJournalError", () => {
	test("extracts an Error's message and bounds its length", () => {
		expect(boundedJournalError(new Error("boom"))).toBe("boom");
		expect(boundedJournalError(new Error("x".repeat(1_000))).length).toBeLessThanOrEqual(300);
	});

	test("stringifies a non-Error throw", () => {
		expect(boundedJournalError("plain string failure")).toBe("plain string failure");
	});
});
