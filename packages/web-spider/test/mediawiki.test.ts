/**
 * Unit tests for the MediaWiki API strategy — no real network, stub
 * IHttpClient. The two API-path and title-prefix variants tested here
 * (/w/api.php vs /api.php, /wiki/ vs /title/) were verified against real
 * Wikipedia and ArchWiki instances before writing this module.
 */
import { describe, expect, it } from "vitest";
import { detectMediaWiki, extractWikiPageTitle, queryMediaWikiPage } from "../src/mediawiki.js";
import type { IHttpClient } from "../src/ports.js";

describe("extractWikiPageTitle", () => {
	it("extracts from the /wiki/<Title> convention (Wikipedia and most installs)", () => {
		expect(extractWikiPageTitle("https://en.wikipedia.org/wiki/Python_(programming_language)")).toBe("Python_(programming_language)");
	});

	it("extracts from the /title/<Title> convention (ArchWiki and others)", () => {
		expect(extractWikiPageTitle("https://wiki.archlinux.org/title/Installation_guide")).toBe("Installation_guide");
	});

	it("extracts from the /index.php/<Title> convention", () => {
		expect(extractWikiPageTitle("https://example.org/index.php/Some_Page")).toBe("Some_Page");
	});

	it("extracts from a ?title= query-string based config", () => {
		expect(extractWikiPageTitle("https://example.org/index.php?title=Some_Page&action=view")).toBe("Some_Page");
	});

	it("decodes URL-encoded characters in the title", () => {
		expect(extractWikiPageTitle("https://en.wikipedia.org/wiki/C%2B%2B")).toBe("C++");
	});

	it("returns null for a bare site root (no article path at all)", () => {
		expect(extractWikiPageTitle("https://en.wikipedia.org/")).toBeNull();
	});

	it("returns null for an invalid URL rather than throwing", () => {
		expect(extractWikiPageTitle("not a url")).toBeNull();
	});
});

function jsonClient(routes: Record<string, unknown>): IHttpClient {
	return {
		async fetch(req) {
			const body = routes[req.url];
			if (body === undefined) {
				return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
				text: async () => JSON.stringify(body),
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		},
	};
}

describe("detectMediaWiki", () => {
	it("detects via /w/api.php (Wikipedia's real convention)", async () => {
		const httpClient = jsonClient({
			"https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json": {
				query: { general: { generator: "MediaWiki 1.47.0-wmf.11", sitename: "Wikipedia" } },
			},
		});
		const result = await detectMediaWiki("https://en.wikipedia.org/wiki/Anything", httpClient);
		expect(result).toEqual({ apiUrl: "https://en.wikipedia.org/w/api.php", siteName: "Wikipedia", generator: "MediaWiki 1.47.0-wmf.11" });
	});

	it("falls back to /api.php when /w/api.php doesn't exist (ArchWiki's real convention)", async () => {
		const httpClient = jsonClient({
			"https://wiki.archlinux.org/api.php?action=query&meta=siteinfo&format=json": {
				query: { general: { generator: "MediaWiki 1.46.0", sitename: "ArchWiki" } },
			},
		});
		const result = await detectMediaWiki("https://wiki.archlinux.org/title/Anything", httpClient);
		expect(result?.apiUrl).toBe("https://wiki.archlinux.org/api.php");
	});

	it("returns null for a non-MediaWiki site (no generator field, or a generator that isn't MediaWiki)", async () => {
		const httpClient = jsonClient({});
		expect(await detectMediaWiki("https://example.com/page", httpClient)).toBeNull();
	});

	it("returns null when a response is 200 but not valid siteinfo JSON shape", async () => {
		const httpClient: IHttpClient = {
			async fetch() {
				return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, text: async () => "not json at all", arrayBuffer: async () => new ArrayBuffer(0) };
			},
		};
		expect(await detectMediaWiki("https://example.com", httpClient)).toBeNull();
	});

	it("returns null for a generator that exists but isn't MediaWiki (e.g. a different wiki engine)", async () => {
		const httpClient = jsonClient({
			"https://example.com/w/api.php?action=query&meta=siteinfo&format=json": { query: { general: { generator: "SomeOtherWiki 2.0", sitename: "X" } } },
			"https://example.com/api.php?action=query&meta=siteinfo&format=json": { query: { general: { generator: "SomeOtherWiki 2.0", sitename: "X" } } },
		});
		expect(await detectMediaWiki("https://example.com", httpClient)).toBeNull();
	});
});

describe("queryMediaWikiPage", () => {
	it("returns the resolved title and rendered article HTML", async () => {
		const httpClient = jsonClient({
			"https://en.wikipedia.org/w/api.php?action=parse&page=Dogfooding&prop=text&format=json&redirects=1": {
				parse: { title: "Eating your own dog food", text: { "*": "<p>Real article content.</p>" } },
			},
		});
		const result = await queryMediaWikiPage("https://en.wikipedia.org/w/api.php", "Dogfooding", httpClient);
		expect(result?.title).toBe("Eating your own dog food"); // resolved through the redirect
		expect(result?.html).toBe("<p>Real article content.</p>");
	});

	it("returns null on an API-level error (e.g. missing page)", async () => {
		const httpClient = jsonClient({
			"https://en.wikipedia.org/w/api.php?action=parse&page=Nonexistent&prop=text&format=json&redirects=1": {
				error: { code: "missingtitle", info: "The page you specified doesn't exist" },
			},
		});
		expect(await queryMediaWikiPage("https://en.wikipedia.org/w/api.php", "Nonexistent", httpClient)).toBeNull();
	});

	it("returns null for an empty/missing text field", async () => {
		const httpClient = jsonClient({
			"https://en.wikipedia.org/w/api.php?action=parse&page=Empty&prop=text&format=json&redirects=1": { parse: { title: "Empty", text: { "*": "" } } },
		});
		expect(await queryMediaWikiPage("https://en.wikipedia.org/w/api.php", "Empty", httpClient)).toBeNull();
	});

	it("returns null on a real 404", async () => {
		const httpClient = jsonClient({});
		expect(await queryMediaWikiPage("https://en.wikipedia.org/w/api.php", "X", httpClient)).toBeNull();
	});
});
