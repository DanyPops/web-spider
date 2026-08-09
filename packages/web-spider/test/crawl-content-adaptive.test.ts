/**
 * TDD for content-adaptive crawl: heuristic best-first ordering, real
 * page_type classification with content-adaptive list shaping, discoverOnly,
 * crawlUrls (selective, no re-discovery), and max_total_chars/deadline_ms
 * budgets reporting an honest nextAction.
 */

import { describe, expect, it } from "vitest";
import { SpiderCache } from "../src/cache/cache.js";
import { DefaultCrawlBudget } from "../src/crawl/budget.js";
import { HeuristicPageClassifier, renderLinkList } from "../src/crawl/classifier.js";
import { crawl } from "../src/crawl/crawl.js";
import type { ICache, IHttpClient } from "../src/ports.js";
import type { Link, SpideredPage } from "../src/types.js";

function htmlWithLinks(title: string, hrefs: string[], paragraphs = 20): string {
	const anchors = hrefs.map((href) => `<a href="${href}">${href}</a>`).join("");
	return `<!DOCTYPE html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"content ".repeat(paragraphs)}</p>${anchors}</article></body></html>`;
}

function listHtml(title: string, hrefs: string[]): string {
	const anchors = hrefs.map((href, i) => `<a href="${href}">Item ${i}</a>`).join("<br/>");
	return `<!DOCTYPE html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${anchors}</article></body></html>`;
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

describe("crawl() default best-first ordering (HeuristicLinkScorer is now the default)", () => {
	it("visits /docs/ before /login/ at the same depth without any explicit linkScorer option", async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/login/help", "https://example.com/docs/guide"]),
			},
			"https://example.com/login/help": { body: htmlWithLinks("Login", []) },
			"https://example.com/docs/guide": { body: htmlWithLinks("Docs", []) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		await crawl("https://example.com", { httpClient: client, maxDepth: 1, concurrency: 1, useSitemap: false });

		expect(fetchOrder).toEqual(["https://example.com", "https://example.com/docs/guide", "https://example.com/login/help"]);
	});
});

describe("crawl() default page classification (HeuristicPageClassifier is now the default)", () => {
	it("classifies a substantial-content page as article by default", async () => {
		const site: Site = { "https://example.com": { body: htmlWithLinks("Home", [], 200) } };
		const result = await crawl("https://example.com", { httpClient: siteClient(site), maxDepth: 0, useSitemap: false });
		expect(result.classifications.get("https://example.com")?.pageType).toBe("article");
	});

	it("classifies a link-dense, low-word-count page as list by default and reshapes its markdown into a rendered link list", async () => {
		const hrefs = Array.from({ length: 20 }, (_, i) => `https://example.com/item-${i}`);
		const site: Site = { "https://example.com": { body: listHtml("Index", hrefs) } };
		const result = await crawl("https://example.com", { httpClient: siteClient(site), maxDepth: 0, useSitemap: false });

		expect(result.classifications.get("https://example.com")?.pageType).toBe("list");
		const page = result.pages.get("https://example.com");
		expect(page?.markdown).toContain("- [Item 0](https://example.com/item-0)");
	});
});

describe("HeuristicPageClassifier unit behavior", () => {
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
	const link = (href: string): Link => ({ href, text: href, isExternal: false, rel: "body" });

	it("classifies js_shell from jsRendered", () => {
		expect(new HeuristicPageClassifier().classify(makePage({ jsRendered: true }))).toEqual({ pageType: "js_shell", contentOk: false });
	});

	it("classifies list from high link density and low word count", () => {
		const links = Array.from({ length: 20 }, (_, i) => link(`https://example.com/${i}`));
		expect(new HeuristicPageClassifier().classify(makePage({ links, wordCount: 30 }))).toEqual({ pageType: "list", contentOk: true });
	});

	it("classifies article from substantial word count", () => {
		expect(new HeuristicPageClassifier().classify(makePage({ wordCount: 500 }))).toEqual({ pageType: "article", contentOk: true });
	});

	it("classifies unknown for a thin, non-list page", () => {
		expect(new HeuristicPageClassifier().classify(makePage({ wordCount: 20 }))).toEqual({ pageType: "unknown", contentOk: true });
	});

	it("never overrides an extractor's own contentOk:false with a false-confidence classification", () => {
		expect(new HeuristicPageClassifier().classify(makePage({ wordCount: 500, contentOk: false }))).toEqual({
			pageType: "unknown",
			contentOk: false,
		});
	});
});

describe("renderLinkList()", () => {
	it("renders each link as a Markdown list item under the page title", () => {
		const page: SpideredPage = {
			url: "https://example.com",
			domain: "example.com",
			fetchedAt: new Date().toISOString(),
			title: "Index",
			description: "",
			author: "",
			publishedAt: "",
			lang: "en",
			tags: [],
			wordCount: 5,
			readingTimeMinutes: 1,
			headings: [],
			chunks: [],
			links: [{ href: "https://example.com/a", text: "A", isExternal: false, rel: "body" }],
			markdown: "ignored",
		};
		expect(renderLinkList(page)).toBe("# Index\n\n- [A](https://example.com/a)\n");
	});

	it("returns empty string for a page with no links", () => {
		expect(
			renderLinkList({
				url: "https://example.com",
				domain: "example.com",
				fetchedAt: new Date().toISOString(),
				title: "Empty",
				description: "",
				author: "",
				publishedAt: "",
				lang: "en",
				tags: [],
				wordCount: 0,
				readingTimeMinutes: 0,
				headings: [],
				chunks: [],
				links: [],
				markdown: "",
			}),
		).toBe("");
	});
});

describe("crawl() discoverOnly", () => {
	it("still fetches pages to discover links but strips markdown/chunks from stored/returned pages", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/a"], 200) },
			"https://example.com/a": { body: htmlWithLinks("A", [], 200) },
		};
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 1,
			concurrency: 1,
			useSitemap: false,
			discoverOnly: true,
		});

		expect(result.pages.size).toBe(2);
		const home = result.pages.get("https://example.com");
		expect(home?.markdown).toBe("");
		expect(home?.chunks).toEqual([]);
		expect(home?.links.length).toBeGreaterThan(0);
		expect(home?.title).toBe("Home");
	});

	it("still classifies pages normally (classification is based on links/wordCount, unaffected by stripping)", async () => {
		const site: Site = { "https://example.com": { body: htmlWithLinks("Home", [], 200) } };
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 0,
			useSitemap: false,
			discoverOnly: true,
		});
		expect(result.classifications.get("https://example.com")?.pageType).toBe("article");
	});

	it("does not poison the shared cache -- a later non-discoverOnly crawl of the same URL still gets full content", async () => {
		const site: Site = { "https://example.com": { body: htmlWithLinks("Home", [], 200) } };
		const client = siteClient(site);
		const sharedCache = new SpiderCache() as ICache<string, SpideredPage>;

		const first = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			useSitemap: false,
			discoverOnly: true,
			cache: sharedCache,
		});
		expect(first.pages.get("https://example.com")?.markdown).toBe("");

		const second = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 0,
			useSitemap: false,
			cache: sharedCache,
		});
		expect(second.pages.get("https://example.com")?.markdown.length).toBeGreaterThan(0);
	});
});

describe("crawl() crawlUrls (selective second-phase crawl, no re-discovery)", () => {
	it("fetches exactly the given URLs and does not follow their links", async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/never-followed"], 200) },
			"https://example.com/a": { body: htmlWithLinks("A", ["https://example.com/never-followed"], 200) },
			"https://example.com/b": { body: htmlWithLinks("B", [], 200) },
			"https://example.com/never-followed": { body: htmlWithLinks("NF", [], 200) },
		};
		const fetchOrder: string[] = [];
		const client = siteClient(site, (url) => fetchOrder.push(url));

		const result = await crawl("https://example.com", {
			httpClient: client,
			maxDepth: 5,
			concurrency: 1,
			useSitemap: false,
			crawlUrls: ["https://example.com/a", "https://example.com/b"],
		});

		expect(fetchOrder.sort()).toEqual(["https://example.com/a", "https://example.com/b"]);
		expect(result.pages.has("https://example.com/never-followed")).toBe(false);
		expect(result.pages.has("https://example.com")).toBe(false);
	});

	it("still respects sameDomainOnly/urlFilter/budget for the given crawlUrls", async () => {
		const site: Site = {
			"https://example.com/a": { body: htmlWithLinks("A", [], 200) },
			"https://other.com/b": { body: htmlWithLinks("B", [], 200) },
		};
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 0,
			useSitemap: false,
			crawlUrls: ["https://example.com/a", "https://other.com/b"],
		});

		expect(result.pages.has("https://example.com/a")).toBe(true);
		expect(result.pages.has("https://other.com/b")).toBe(false);
	});
});

describe("crawl() nextAction reporting", () => {
	it('reports "complete" when the frontier simply runs out', async () => {
		const site: Site = { "https://example.com": { body: htmlWithLinks("Home", [], 5) } };
		const result = await crawl("https://example.com", { httpClient: siteClient(site), maxDepth: 1, useSitemap: false });
		expect(result.nextAction).toBe("complete");
	});

	it('reports "max-pages" when maxPages stops the crawl before the frontier is exhausted', async () => {
		const site: Site = {
			"https://example.com": {
				body: htmlWithLinks("Home", ["https://example.com/a", "https://example.com/b"], 5),
			},
			"https://example.com/a": { body: htmlWithLinks("A", [], 5) },
			"https://example.com/b": { body: htmlWithLinks("B", [], 5) },
		};
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 1,
			maxPages: 2,
			useSitemap: false,
		});
		expect(result.nextAction).toBe("max-pages");
	});

	it('reports "max-total-chars" when a DefaultCrawlBudget\'s char cap stops the crawl', async () => {
		const bigBody = htmlWithLinks("Home", ["https://example.com/a"], 500);
		const site: Site = {
			"https://example.com": { body: bigBody },
			"https://example.com/a": { body: htmlWithLinks("A", [], 500) },
		};
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 1,
			useSitemap: false,
			budget: new DefaultCrawlBudget({ maxPages: 50, maxTotalChars: 100 }),
		});
		expect(result.nextAction).toBe("max-total-chars");
		expect(result.pages.size).toBe(1);
	});

	it('reports "deadline" when a DefaultCrawlBudget\'s deadline stops the crawl', async () => {
		const site: Site = {
			"https://example.com": { body: htmlWithLinks("Home", ["https://example.com/a"], 5) },
			"https://example.com/a": { body: htmlWithLinks("A", [], 5) },
		};
		const result = await crawl("https://example.com", {
			httpClient: siteClient(site),
			maxDepth: 1,
			useSitemap: false,
			budget: new DefaultCrawlBudget({ maxPages: 50, deadlineMs: 0 }),
		});
		expect(result.nextAction).toBe("deadline");
	});
});
