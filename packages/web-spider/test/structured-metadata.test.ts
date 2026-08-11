import { describe, expect, it } from "vitest";
import { extractJsonLd, extractOpenGraph, extractTwitterCard, parseDom } from "../src/extract/parse.js";
import { spider } from "../src/fetch/spider.js";
import type { IHttpClient } from "../src/ports.js";

function responseClient(contentType: string, body: string): IHttpClient {
	return {
		async fetch() {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
				text: async () => body,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// extractOpenGraph
// ---------------------------------------------------------------------------

describe("extractOpenGraph", () => {
	it("collects og:* meta tags keyed by full property name", () => {
		const doc = parseDom(
			`<html><head>
				<meta property="og:title" content="The Rock" />
				<meta property="og:type" content="video.movie" />
				<meta property="og:image" content="https://example.com/rock.jpg" />
				<meta property="og:image:width" content="400" />
			</head><body></body></html>`,
			"https://example.com",
		);
		expect(extractOpenGraph(doc)).toEqual({
			"og:title": "The Rock",
			"og:type": "video.movie",
			"og:image": "https://example.com/rock.jpg",
			"og:image:width": "400",
		});
	});

	it("first occurrence wins on a repeated property, per the OGP spec's own conflict rule", () => {
		const doc = parseDom(
			`<html><head>
				<meta property="og:image" content="https://example.com/first.jpg" />
				<meta property="og:image" content="https://example.com/second.jpg" />
			</head><body></body></html>`,
			"https://example.com",
		);
		expect(extractOpenGraph(doc)["og:image"]).toBe("https://example.com/first.jpg");
	});

	it('also reads a non-conformant name="og:..." attribute for robustness', () => {
		const doc = parseDom(`<html><head><meta name="og:title" content="Non-conformant"/></head><body></body></html>`, "https://example.com");
		expect(extractOpenGraph(doc)).toEqual({ "og:title": "Non-conformant" });
	});

	it("returns an empty object for a page with no og:* tags", () => {
		const doc = parseDom(`<html><head><title>Plain</title></head><body></body></html>`, "https://example.com");
		expect(extractOpenGraph(doc)).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// extractTwitterCard
// ---------------------------------------------------------------------------

describe("extractTwitterCard", () => {
	it("collects twitter:* meta tags keyed by full property name", () => {
		const doc = parseDom(
			`<html><head>
				<meta name="twitter:card" content="summary_large_image" />
				<meta name="twitter:title" content="A tweet-worthy title" />
			</head><body></body></html>`,
			"https://example.com",
		);
		expect(extractTwitterCard(doc)).toEqual({ "twitter:card": "summary_large_image", "twitter:title": "A tweet-worthy title" });
	});

	it("first occurrence wins on a repeat", () => {
		const doc = parseDom(
			`<html><head><meta name="twitter:card" content="first"/><meta name="twitter:card" content="second"/></head><body></body></html>`,
			"https://example.com",
		);
		expect(extractTwitterCard(doc)["twitter:card"]).toBe("first");
	});

	it("returns an empty object for a page with no twitter:* tags", () => {
		const doc = parseDom(`<html><head></head><body></body></html>`, "https://example.com");
		expect(extractTwitterCard(doc)).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// extractJsonLd
// ---------------------------------------------------------------------------

describe("extractJsonLd", () => {
	it("parses a single JSON-LD block into one entry", () => {
		const doc = parseDom(
			`<html><head><script type="application/ld+json">{"@type":"Article","headline":"Hello"}</script></head><body></body></html>`,
			"https://example.com",
		);
		expect(extractJsonLd(doc)).toEqual([{ "@type": "Article", headline: "Hello" }]);
	});

	it("spreads a top-level array block into individual entries", () => {
		const doc = parseDom(
			`<html><head><script type="application/ld+json">[{"@type":"Article"},{"@type":"BreadcrumbList"}]</script></head><body></body></html>`,
			"https://example.com",
		);
		expect(extractJsonLd(doc)).toEqual([{ "@type": "Article" }, { "@type": "BreadcrumbList" }]);
	});

	it("combines multiple script blocks in document order", () => {
		const doc = parseDom(
			`<html><head>
				<script type="application/ld+json">{"@type":"Organization"}</script>
				<script type="application/ld+json">{"@type":"Article"}</script>
			</head><body></body></html>`,
			"https://example.com",
		);
		expect(extractJsonLd(doc)).toEqual([{ "@type": "Organization" }, { "@type": "Article" }]);
	});

	it("skips a malformed block instead of throwing, still returning valid siblings", () => {
		const doc = parseDom(
			`<html><head>
				<script type="application/ld+json">{not valid json}</script>
				<script type="application/ld+json">{"@type":"Article"}</script>
			</head><body></body></html>`,
			"https://example.com",
		);
		expect(extractJsonLd(doc)).toEqual([{ "@type": "Article" }]);
	});

	it("returns an empty array for a page with no JSON-LD", () => {
		const doc = parseDom(`<html><head></head><body></body></html>`, "https://example.com");
		expect(extractJsonLd(doc)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// End-to-end via spider() -- confirms wiring into htmlExtractor, and that the
// full view carries these fields while the lean view never does.
// ---------------------------------------------------------------------------

const RICH_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Rich Page</title>
  <meta property="og:title" content="Rich Page OG Title" />
  <meta property="og:description" content="An OG description" />
  <meta name="twitter:card" content="summary" />
  <script type="application/ld+json">{"@type":"Article","headline":"Rich Page"}</script>
</head>
<body>
  <article>
    <h1>Rich Page</h1>
    <p>${"Enough article prose for Readability to extract this as a real article. ".repeat(20)}</p>
  </article>
</body>
</html>`;

describe("structured metadata via spider() (full HTML extraction path)", () => {
	it("the full view carries openGraph/twitterCard/jsonLd", async () => {
		const page = await spider("https://example.com/rich", { httpClient: responseClient("text/html", RICH_HTML) });
		expect(page.openGraph).toEqual({ "og:title": "Rich Page OG Title", "og:description": "An OG description" });
		expect(page.twitterCard).toEqual({ "twitter:card": "summary" });
		expect(page.jsonLd).toEqual([{ "@type": "Article", headline: "Rich Page" }]);
	});

	it("a page with none of these present omits all three fields entirely (not empty objects/arrays)", async () => {
		const plain = `<!doctype html><html><head><title>Plain</title></head><body><article><p>${"Plain article text with enough words for extraction. ".repeat(20)}</p></article></body></html>`;
		const page = await spider("https://example.com/plain", { httpClient: responseClient("text/html", plain) });
		expect(page.openGraph).toBeUndefined();
		expect(page.twitterCard).toBeUndefined();
		expect(page.jsonLd).toBeUndefined();
	});

	it("the lean view never carries these fields, even when the page has them (LeanPage's own deliberately slim shape)", async () => {
		const page = await spider("https://example.com/rich", { httpClient: responseClient("text/html", RICH_HTML), view: "lean" });
		expect(page).not.toHaveProperty("openGraph");
		expect(page).not.toHaveProperty("twitterCard");
		expect(page).not.toHaveProperty("jsonLd");
	});
});
