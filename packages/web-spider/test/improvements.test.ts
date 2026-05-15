/**
 * Tests for the six improvement tasks (PII-TSK-8 through PII-TSK-13).
 * Written before implementation — all should fail until code is in place.
 */

import { describe, expect, it } from "vitest";
import { spider } from "../src/spider.js";
import { crawl } from "../src/crawl.js";
import type { IHttpClient } from "../src/ports.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mockClient(responses: Record<string, { status?: number; body: string }>): IHttpClient {
	return {
		fetch: async (req) => {
			const entry = responses[req.url] ?? responses["*"];
			if (!entry) throw new Error(`Unexpected fetch: ${req.url}`);
			const status = entry.status ?? 200;
			return {
				ok: status >= 200 && status < 300,
				status,
				statusText: status === 200 ? "OK" : "Error",
				headers: { get: () => null },
				text: async () => entry.body,
			};
		},
	};
}

const articleHtml = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head><title>${title}</title><meta name="description" content="test"></head>
<body><article><h1>${title}</h1>${body}</article></body>
</html>`;

const LONG_BODY = `<p>${"Word ".repeat(300)}</p><h2>Section</h2><p>${"More words. ".repeat(300)}</p>`;

// ---------------------------------------------------------------------------
// PII-TSK-9: Graceful degradation on JS-rendered pages
// ---------------------------------------------------------------------------

describe("PII-TSK-9: JS-rendered pages degrade gracefully", () => {
	const jsHtml = `<!DOCTYPE html><html><head><title>App</title></head>
<body><div id="root"></div><script>/* SPA */</script></body></html>`;

	it("returns a page with jsRendered:true instead of throwing", async () => {
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: jsHtml } }),
		});
		expect((page as { jsRendered?: boolean }).jsRendered).toBe(true);
	});

	it("still returns title and links from JS page", async () => {
		const html = `<!DOCTYPE html><html><head><title>My SPA</title></head>
<body><div id="root"></div><a href="/about">About</a></body></html>`;
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: html } }),
		});
		expect(page.title).toContain("My SPA");
		expect(page.links.length).toBeGreaterThan(0);
	});

	it("returns empty chunks and markdown for JS page", async () => {
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: jsHtml } }),
		});
		expect(page.chunks).toHaveLength(0);
		expect(page.markdown).toBe("");
	});

	it("lean view also degrades instead of throwing", async () => {
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: jsHtml } }),
			view: "lean",
		});
		expect((page as { jsRendered?: boolean }).jsRendered).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// PII-TSK-13: Chunk-aware tokenBudget
// ---------------------------------------------------------------------------

describe("PII-TSK-13: chunk-aware tokenBudget", () => {
	it("returns whole chunks up to budget, not truncated mid-sentence", async () => {
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: articleHtml("Test", LONG_BODY) } }),
			tokenBudget: 100,
		});
		// Should have at least one complete chunk
		expect(page.chunks.length).toBeGreaterThan(0);
		// Markdown should not end with truncation notice
		expect(page.markdown).not.toContain("truncated to ~");
		// Each chunk should end at a word boundary (not mid-word)
		for (const c of page.chunks) {
			expect(c.text.trim()).not.toMatch(/\w-$/);
		}
	});

	it("total chunk text fits within budget (first chunk may overflow)", async () => {
		const budget = 100;
		const page = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: articleHtml("Test", LONG_BODY) } }),
			tokenBudget: budget,
		});
		const totalChars = page.chunks.reduce((sum, c) => sum + c.text.length, 0);
		// The first chunk is always included even if it exceeds the budget.
		// From chunk 2 onward, total must stay within budget.
		const firstChunkLen = page.chunks[0]?.text.length ?? 0;
		const rest = totalChars - firstChunkLen;
		expect(rest).toBeLessThanOrEqual(budget * 4);
	});

	it("without budget, returns all chunks", async () => {
		const withBudget = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: articleHtml("Test", LONG_BODY) } }),
			tokenBudget: 50,
		});
		const withoutBudget = await spider("https://example.com", {
			httpClient: mockClient({ "*": { body: articleHtml("Test", LONG_BODY) } }),
		});
		expect(withBudget.chunks.length).toBeLessThan(withoutBudget.chunks.length);
	});
});

// ---------------------------------------------------------------------------
// PII-TSK-12: Sitemap discovery
// ---------------------------------------------------------------------------

describe("PII-TSK-12: sitemap.xml seeds crawl frontier", () => {
	const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-a</loc></url>
  <url><loc>https://example.com/page-b</loc></url>
  <url><loc>https://example.com/page-c</loc></url>
</urlset>`;

	const pageHtml = articleHtml("Page", "<p>Content here. ".repeat(20) + "</p>");

	it("fetches sitemap.xml and includes those URLs in crawl", async () => {
		const visited: string[] = [];
		const client = mockClient({
			"https://example.com": { body: pageHtml },
			"https://example.com/sitemap.xml": { body: sitemapXml },
			"https://example.com/page-a": { body: pageHtml },
			"https://example.com/page-b": { body: pageHtml },
			"https://example.com/page-c": { body: pageHtml },
		});

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			maxPages: 10,
			useSitemap: true,
			onPage: (p) => visited.push(p.url),
		});

		expect(result.pages.has("https://example.com/page-a")).toBe(true);
		expect(result.pages.has("https://example.com/page-b")).toBe(true);
		expect(result.pages.has("https://example.com/page-c")).toBe(true);
	});

	it("falls back to normal BFS when sitemap is missing (404)", async () => {
		const client = mockClient({
			"https://example.com": { body: articleHtml("Home", '<p>Text. <a href="/about">About</a></p>') },
			"https://example.com/sitemap.xml": { status: 404, body: "" },
			"https://example.com/about": { body: pageHtml },
		});

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			useSitemap: true,
		});

		expect(result.pages.size).toBeGreaterThan(0);
		// Should not throw even though sitemap 404d
	});

	it("sitemap disabled when useSitemap:false", async () => {
		const sitemapFetched = { value: false };
		const client: IHttpClient = {
			fetch: async (req) => {
				if (req.url.includes("sitemap")) sitemapFetched.value = true;
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: () => null },
					text: async () => pageHtml,
				};
			},
		};

		await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			useSitemap: false,
		});

		expect(sitemapFetched.value).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// PII-TSK-11: Disk cache (tested via ICache contract)
// ---------------------------------------------------------------------------

import { DiskCache } from "../src/disk-cache.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpideredPage } from "../src/types.js";

describe("PII-TSK-11: DiskCache persists across instances", () => {
	function makePage(url: string): SpideredPage {
		return {
			url, domain: "example.com", fetchedAt: new Date().toISOString(),
			title: "Test", description: "desc", author: "", publishedAt: "",
			lang: "en", tags: [], wordCount: 10, readingTimeMinutes: 1,
			headings: [], chunks: [], links: [], markdown: "hello",
		};
	}

	it("persists a page and retrieves it in a new instance", () => {
		const dir = mkdtempSync(join(tmpdir(), "spider-cache-"));
		const path = join(dir, "cache.json");
		try {
			const cache1 = new DiskCache(path);
			const page = makePage("https://example.com/a");
			cache1.set("https://example.com/a", page);
			cache1.flush();

			const cache2 = new DiskCache(path);
			const retrieved = cache2.get("https://example.com/a");
			expect(retrieved?.url).toBe("https://example.com/a");
			expect(retrieved?.markdown).toBe("hello");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("returns undefined for expired entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "spider-cache-"));
		const path = join(dir, "cache.json");
		try {
			const cache = new DiskCache(path, { ttlMs: 1 }); // 1ms TTL
			cache.set("https://example.com/b", makePage("https://example.com/b"));
			cache.flush();

			// Wait for TTL to expire
			const waited = Date.now() + 5;
			while (Date.now() < waited) { /* spin */ }

			const cache2 = new DiskCache(path, { ttlMs: 1 });
			expect(cache2.get("https://example.com/b")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("implements ICache interface", () => {
		const dir = mkdtempSync(join(tmpdir(), "spider-cache-"));
		const path = join(dir, "cache.json");
		try {
			const cache = new DiskCache(path);
			const page = makePage("https://example.com/c");
			expect(cache.has("https://example.com/c")).toBe(false);
			cache.set("https://example.com/c", page);
			expect(cache.has("https://example.com/c")).toBe(true);
			cache.delete("https://example.com/c");
			expect(cache.has("https://example.com/c")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
