import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../src/cache-key.js";

describe("canonicalizeUrl", () => {
	it("strips a trailing slash", () => {
		expect(canonicalizeUrl("https://example.com/docs/")).toBe("https://example.com/docs");
	});

	it("strips a fragment", () => {
		expect(canonicalizeUrl("https://example.com/docs#section")).toBe("https://example.com/docs");
	});

	it("sorts query parameters into a stable order", () => {
		expect(canonicalizeUrl("https://example.com/search?b=2&a=1")).toBe(canonicalizeUrl("https://example.com/search?a=1&b=2"));
		expect(canonicalizeUrl("https://example.com/search?b=2&a=1")).toBe("https://example.com/search?a=1&b=2");
	});

	it("treats a bare origin with and without a trailing slash as the same key", () => {
		expect(canonicalizeUrl("https://example.com")).toBe(canonicalizeUrl("https://example.com/"));
	});

	it("combines fragment-stripping and query-order normalization together", () => {
		expect(canonicalizeUrl("https://example.com/page?b=2&a=1#section")).toBe("https://example.com/page?a=1&b=2");
	});

	it("returns the raw string unchanged for an unparseable URL, rather than throwing", () => {
		expect(canonicalizeUrl("not a url")).toBe("not a url");
	});

	it("leaves a URL with no query string or fragment unchanged (aside from a trailing slash)", () => {
		expect(canonicalizeUrl("https://example.com/plain/path")).toBe("https://example.com/plain/path");
	});
});
