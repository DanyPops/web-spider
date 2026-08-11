import { describe, expect, test } from "bun:test";
import { buildDomainFilter, matchesDomain } from "../src/fetch/domain-filter.ts";

describe("matchesDomain", () => {
	test("matches the exact hostname, case-insensitively", () => {
		expect(matchesDomain("Example.com", "example.com")).toBe(true);
		expect(matchesDomain("example.com", "Example.COM")).toBe(true);
	});

	test("matches a subdomain of the given domain", () => {
		expect(matchesDomain("www.example.com", "example.com")).toBe(true);
		expect(matchesDomain("docs.api.example.com", "example.com")).toBe(true);
	});

	test("does not match an unrelated domain that merely shares a suffix string", () => {
		expect(matchesDomain("notexample.com", "example.com")).toBe(false);
		expect(matchesDomain("example.com.evil.test", "example.com")).toBe(false);
	});
});

describe("buildDomainFilter", () => {
	test("returns undefined when both lists are empty/absent -- no urlFilter overhead for callers who don't use this", () => {
		expect(buildDomainFilter(undefined, undefined)).toBeUndefined();
		expect(buildDomainFilter([], [])).toBeUndefined();
	});

	test("excludeDomains rejects a matching host and its subdomains, allows everything else", () => {
		const filter = buildDomainFilter(["blocked.example"], undefined);
		expect(filter?.("https://blocked.example/x")).toBe(false);
		expect(filter?.("https://sub.blocked.example/x")).toBe(false);
		expect(filter?.("https://allowed.example/x")).toBe(true);
	});

	test("includeDomains allows only a matching host and its subdomains, rejects everything else", () => {
		const filter = buildDomainFilter(undefined, ["allowed.example"]);
		expect(filter?.("https://allowed.example/x")).toBe(true);
		expect(filter?.("https://sub.allowed.example/x")).toBe(true);
		expect(filter?.("https://other.example/x")).toBe(false);
	});

	test("includeDomains and excludeDomains compose -- include narrows first, exclude then further narrows", () => {
		const filter = buildDomainFilter(["blocked.allowed.example"], ["allowed.example"]);
		expect(filter?.("https://allowed.example/x")).toBe(true);
		expect(filter?.("https://blocked.allowed.example/x")).toBe(false); // included by domain, but excluded by subdomain
		expect(filter?.("https://other.example/x")).toBe(false); // not included at all
	});

	test("an unparseable URL fails closed (excluded) rather than throwing", () => {
		const filter = buildDomainFilter(["blocked.example"], undefined);
		expect(filter?.("not a url")).toBe(false);
	});

	test("blank entries in either list are ignored, not treated as a wildcard", () => {
		const filter = buildDomainFilter(["", "  "], undefined);
		expect(filter).toBeUndefined();
	});
});
