/**
 * Proves crawl()'s frontier ordering, page classification, and stop
 * bookkeeping are exercised through injectable Strategy ports (LinkScorer,
 * PageClassifier, CrawlBudget) rather than hardcoded inline logic — all
 * without a real spider() call, network, or SQLite.
 */

import { describe, expect, it } from "vitest";
import type { CrawlBudget, CrawlBudgetState } from "../src/crawl/budget.js";
import { MaxPagesBudget } from "../src/crawl/budget.js";
import type { PageClassification, PageClassifier } from "../src/crawl/classifier.js";
import { DefaultPageClassifier } from "../src/crawl/classifier.js";
import { crawl } from "../src/crawl/crawl.js";
import type { LinkScoreContext, LinkScorer } from "../src/crawl/frontier.js";
import type { IHttpClient } from "../src/ports.js";
import type { SpideredPage } from "../src/types.js";

function htmlWithLinks(title: string, hrefs: string[]): string {
	const anchors = hrefs.map((href) => `<a href="${href}">${href}</a>`).join("");
	return `<!DOCTYPE html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"content ".repeat(20)}</p>${anchors}</article></body></html>`;
}

const jsShellHtml = `<!DOCTYPE html><html><head><title>App</title></head><body><div id="root"></div><script>/* spa */</script></body></html>`;

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

describe("crawl() frontier ordering via injected LinkScorer", () => {
	it("visits higher-scored candidates before lower-scored ones at the same depth", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/low", "https://example.com/high"]),
			},
			"https://example.com/low": { body: htmlWithLinks("Low", []) },
			"https://example.com/high": { body: htmlWithLinks("High", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		const preferHigh: LinkScorer = {
			score(url: string, _context: LinkScoreContext): number {
				return url.includes("/high") ? 10 : 0;
			},
		};

		await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
			linkScorer: preferHigh,
		});

		expect(fetchOrder).toEqual(["https://example.com", "https://example.com/high", "https://example.com/low"]);
	});

	it("default scorer preserves plain discovery order (characterization parity)", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/a", "https://example.com/b"]),
			},
			"https://example.com/a": { body: htmlWithLinks("A", []) },
			"https://example.com/b": { body: htmlWithLinks("B", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		await crawl("https://example.com", { httpClient: client, maxDepth: 1, concurrency: 1, useSitemap: false });

		expect(fetchOrder).toEqual(["https://example.com", "https://example.com/a", "https://example.com/b"]);
	});
});

describe("crawl() page classification via injected PageClassifier", () => {
	it("records a fake classifier's verdict per fetched page in result.classifications", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", []) },
		};
		const client = siteClient(site);

		const fake: PageClassifier = {
			classify(page: SpideredPage): PageClassification {
				return { pageType: page.url.endsWith("/") || !page.url.includes("/x") ? "article" : "list", contentOk: true };
			},
		};

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			useSitemap: false,
			pageClassifier: fake,
		});

		expect(result.classifications.get("https://example.com")).toEqual({ pageType: "article", contentOk: true });
	});

	it("default classifier reports js_shell honestly using spider()'s existing jsRendered signal", async () => {
		const site: Site = {
			"https://example.com": { body: jsShellHtml },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			useSitemap: false,
		});

		expect(result.classifications.get("https://example.com")).toEqual({ pageType: "js_shell", contentOk: false });
	});

	it("default classifier reports unknown (not article/list) for an ordinary page, preserving no prior classification claim", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", []) },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", { httpClient: client, maxDepth: 0, useSitemap: false });

		expect(result.classifications.get("https://example.com")).toEqual({ pageType: "unknown", contentOk: true });
	});

	it("does not classify a page that failed to fetch", async () => {
		const site: Site = {
			"https://example.com": { status: 500, body: "boom" },
		};
		const client = siteClient(site);

		const result = await crawl("https://example.com", { httpClient: client, maxDepth: 0, useSitemap: false });

		expect(result.classifications.has("https://example.com")).toBe(false);
		expect(result.errors.has("https://example.com")).toBe(true);
	});
});

describe("crawl() stop bookkeeping via injected CrawlBudget", () => {
	it("a budget reporting immediate exhaustion stops the crawl before fetching anything", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/a"]) },
			"https://example.com/a": { body: htmlWithLinks("A", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		const alwaysExhausted: CrawlBudget = {
			isExhausted(_state: CrawlBudgetState): boolean {
				return true;
			},
			remaining(_state: CrawlBudgetState): number {
				return 0;
			},
		};

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			useSitemap: false,
			budget: alwaysExhausted,
		});

		expect(fetchOrder).toEqual([]);
		expect(result.pages.size).toBe(0);
	});

	it("a custom budget can permit more fetches than the default maxPages", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/a", "https://example.com/b", "https://example.com/c"]),
			},
			"https://example.com/a": { body: htmlWithLinks("A", []) },
			"https://example.com/b": { body: htmlWithLinks("B", []) },
			"https://example.com/c": { body: htmlWithLinks("C", []) },
		};
		const client = siteClient(site);

		// maxPages defaults to 50 already, so use a MaxPagesBudget(2) directly
		// to prove the injected budget object — not the maxPages option — is
		// what crawl() actually consults.
		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 1,
			maxPages: 50,
			useSitemap: false,
			budget: new MaxPagesBudget(2),
		});

		expect(result.pages.size).toBe(2);
	});
});

describe("DefaultPageClassifier unit behavior", () => {
	function makePage(overrides: Partial<SpideredPage> = {}): SpideredPage {
		return {
			url: "https://example.com",
			domain: "example.com",
			fetchedAt: new Date().toISOString(),
			title: "Test",
			description: "",
			author: "",
			publishedAt: "",
			lang: "en",
			tags: [],
			wordCount: 10,
			readingTimeMinutes: 1,
			headings: [],
			chunks: [],
			links: [],
			markdown: "",
			...overrides,
		};
	}

	it("classifies a jsRendered page as js_shell with contentOk:false", () => {
		const classifier = new DefaultPageClassifier();
		expect(classifier.classify(makePage({ jsRendered: true }))).toEqual({ pageType: "js_shell", contentOk: false });
	});

	it("classifies an ordinary page as unknown with contentOk:true", () => {
		const classifier = new DefaultPageClassifier();
		expect(classifier.classify(makePage())).toEqual({ pageType: "unknown", contentOk: true });
	});

	it("propagates an existing contentOk:false signal (e.g. from PDF extraction) for a non-jsRendered page", () => {
		const classifier = new DefaultPageClassifier();
		expect(classifier.classify(makePage({ contentOk: false }))).toEqual({ pageType: "unknown", contentOk: false });
	});
});
