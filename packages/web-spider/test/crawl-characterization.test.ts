/**
 * Characterization tests for crawl()'s current BFS behavior, written before
 * extracting the LinkScorer/PageClassifier/CrawlBudget Strategy boundary.
 * These pin observable behavior (traversal order, maxPages/maxDepth,
 * sameDomainOnly, urlFilter, and per-URL error isolation) so the refactor
 * cannot silently change it.
 */

import { describe, expect, it } from "vitest";
import { crawl } from "../src/crawl/crawl.js";
import type { IHttpClient } from "../src/ports.js";

function htmlWithLinks(title: string, hrefs: string[]): string {
	const anchors = hrefs.map((href) => `<a href="${href}">${href}</a>`).join("");
	return `<!DOCTYPE html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"content ".repeat(20)}</p>${anchors}</article></body></html>`;
}

interface Site {
	[url: string]: { status?: number; body: string };
}

function siteClient(site: Site, onFetch?: (url: string) => void): IHttpClient {
	return {
		fetch: async (req) => {
			onFetch?.(req.url);
			const entry = site[req.url];
			if (!entry) {
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					headers: { get: () => null },
					text: async () => "",
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			const status = entry.status ?? 200;
			return {
				ok: status >= 200 && status < 300,
				status,
				statusText: status === 200 ? "OK" : "Error",
				headers: { get: () => null },
				text: async () => entry.body,
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		},
	};
}

describe("crawl() characterization (pre-refactor pin)", () => {
	it("visits the start page then its depth-1 links in discovery order", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/a", "https://example.com/b"]) },
			"https://example.com/a": { body: htmlWithLinks("A", []) },
			"https://example.com/b": { body: htmlWithLinks("B", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			maxPages: 10,
			concurrency: 1,
			useSitemap: false,
		});

		expect(fetchOrder).toEqual(["https://example.com", "https://example.com/a", "https://example.com/b"]);
		expect(result.pages.size).toBe(3);
	});

	it("stops discovering new links once maxDepth is reached", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/a"]) },
			"https://example.com/a": { body: htmlWithLinks("A", ["https://example.com/b"]) },
			"https://example.com/b": { body: htmlWithLinks("B", []) },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
		});

		expect(result.pages.has("https://example.com")).toBe(true);
		expect(result.pages.has("https://example.com/a")).toBe(true);
		// /b is only discovered at depth 2, beyond maxDepth:1 — never fetched.
		expect(result.pages.has("https://example.com/b")).toBe(false);
	});

	it("caps total fetched pages at maxPages even when more links are discovered", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/a", "https://example.com/b", "https://example.com/c"]),
			},
			"https://example.com/a": { body: htmlWithLinks("A", []) },
			"https://example.com/b": { body: htmlWithLinks("B", []) },
			"https://example.com/c": { body: htmlWithLinks("C", []) },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			maxPages: 2,
			concurrency: 1,
			useSitemap: false,
		});

		expect(result.pages.size).toBe(2);
	});

	it("does not follow links to a different domain when sameDomainOnly is true (default)", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/a", "https://other.com/external"]),
			},
			"https://example.com/a": { body: htmlWithLinks("A", []) },
			"https://other.com/external": { body: htmlWithLinks("External", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
		});

		expect(fetchOrder).not.toContain("https://other.com/external");
	});

	it("skips URLs rejected by a custom urlFilter", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/keep", "https://example.com/skip"]),
			},
			"https://example.com/keep": { body: htmlWithLinks("Keep", []) },
			"https://example.com/skip": { body: htmlWithLinks("Skip", []) },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
			urlFilter: (url) => !url.endsWith("/skip"),
		});

		expect(result.pages.has("https://example.com/keep")).toBe(true);
		expect(result.pages.has("https://example.com/skip")).toBe(false);
	});

	it("isolates a per-URL fetch failure into the errors map without stopping the rest of the crawl", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/ok", "https://example.com/broken"]),
			},
			"https://example.com/ok": { body: htmlWithLinks("Ok", []) },
			"https://example.com/broken": { status: 500, body: "boom" },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
		});

		expect(result.pages.has("https://example.com/ok")).toBe(true);
		expect(result.errors.has("https://example.com/broken")).toBe(true);
	});
});
