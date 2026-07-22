/**
 * Regression test for a real bug found via dogfooding: Readability.parse()
 * mutates the DOM it's given, and on a real live page
 * (gitlab.com/gitlab-org/gitlab) that mutation ends up removing the
 * document's root element entirely -- documentElement becomes null.
 * spider.ts read doc.documentElement.lang right after the parse() call with
 * no guard, crashing with "null is not an object".
 *
 * Verified directly against the real page before writing this fix:
 *   BEFORE Readability, documentElement is null: false
 *   AFTER  Readability, documentElement is null: true
 *
 * Rather than committing a large, licensing-uncertain, version-fragile real
 * page as a fixture, this mocks @mozilla/readability's parse() to perform
 * the exact realistic side effect observed on the real page (removing the
 * root element) -- testing the real vulnerability class (Readability may
 * mutate/remove nodes; downstream code must not assume they still exist)
 * without depending on Readability's specific internal heuristics or
 * version, which could change and make a "real trigger HTML" fixture stop
 * reproducing the bug over time.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@mozilla/readability", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mozilla/readability")>();
	return {
		...actual,
		Readability: class {
			constructor(private doc: Document) {}
			parse() {
				const real = new actual.Readability(this.doc).parse();
				// Simulate the real, observed side effect: Readability's own
				// cleanup pass ends up removing the document's root element.
				this.doc.documentElement?.remove();
				return real;
			}
		},
	};
});

describe("spider() — Readability nulling documentElement", () => {
	it("does not crash, and falls back to lang: 'en', when documentElement is null after Readability.parse()", async () => {
		const { spider } = await import("../src/spider.js");
		const httpClient = {
			async fetch() {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () =>
						'<html lang="en"><head><title>Real Page</title></head><body><article><p>Real content, long enough for Readability\'s extraction heuristics to treat this as a genuine article body rather than boilerplate noise.</p></article></body></html>',
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};

		const page = await spider("https://example.com/page", { httpClient });
		expect(page.lang).toBe("en"); // the fallback, not a crash
		expect(page.title).toBe("Real Page");
	});

	it("does not crash for the lean and tree views either", async () => {
		const { spider } = await import("../src/spider.js");
		const httpClient = {
			async fetch() {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () =>
						'<html lang="en"><head><title>Real Page</title></head><body><article><p>Real content, long enough for Readability\'s extraction heuristics to treat this as a genuine article body rather than boilerplate noise.</p></article></body></html>',
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};

		const lean = await spider("https://example.com/page", { httpClient, view: "lean" });
		expect(lean.lang).toBe("en");

		const tree = await spider("https://example.com/page", { httpClient, view: "tree" });
		expect(tree.lang).toBe("en");
	});
});
