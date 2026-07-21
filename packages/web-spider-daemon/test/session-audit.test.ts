import { describe, expect, test } from "bun:test";
import { boundedJournalError, journalTargetFor, sanitizeUrlForJournal } from "../src/domain/session-audit.ts";

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

describe("journalTargetFor", () => {
	test("navigate: the sanitized URL", () => {
		expect(journalTargetFor("navigate", { url: "https://example.com/x" })).toBe("https://example.com/x");
	});

	test("click: the selector, bounded", () => {
		expect(journalTargetFor("click", { selector: "#submit" })).toBe("#submit");
		expect(journalTargetFor("click", { selector: "a".repeat(1_000) }).length).toBeLessThanOrEqual(200);
	});

	test("eval: always the fixed placeholder, regardless of any script-shaped input", () => {
		expect(journalTargetFor("eval", {})).toBe("<script>");
	});

	test("screenshot: always the fixed placeholder", () => {
		expect(journalTargetFor("screenshot", {})).toBe("<screenshot>");
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
