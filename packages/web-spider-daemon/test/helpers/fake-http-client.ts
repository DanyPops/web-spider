import type { HttpRequest, HttpResponse, IHttpClient } from "@danypops/web-spider";

export interface FakeRoute {
	status?: number;
	body: string;
	headers?: Record<string, string>;
}

/**
 * Minimal IHttpClient stub — no real network, no mocking library. Matches the
 * established pattern in packages/web-spider/test/ports.test.ts and
 * packages/web-spider/test/improvements.test.ts (plain object satisfying the
 * port). Route by exact URL, or "*" as a catch-all default.
 */
export function fakeHttpClient(routes: Record<string, FakeRoute>): IHttpClient {
	return {
		async fetch(req: HttpRequest): Promise<HttpResponse> {
			const route = routes[req.url] ?? routes["*"];
			if (!route) throw new Error(`fakeHttpClient: no route for ${req.url}`);
			const status = route.status ?? 200;
			const headers = route.headers ?? {};
			return {
				ok: status >= 200 && status < 300,
				status,
				statusText: status === 200 ? "OK" : "Error",
				headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
				text: async () => route.body,
				arrayBuffer: async () => new TextEncoder().encode(route.body).buffer,
			};
		},
	};
}

export const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Fixture Article</title>
  <meta name="description" content="A fixture page for daemon fetch/crawl tests">
</head>
<body>
  <article>
    <h1>Fixture Article</h1>
    <h2>Section One</h2>
    <p>This fixture page carries enough prose for Readability to extract meaningful
       content, including headings, links, and multiple paragraphs of body text
       about rate limiting and exponential backoff strategies used by web crawlers.</p>
    <h2>Section Two</h2>
    <p>A second paragraph discusses caching and chunking strategies used to keep
       token budgets bounded when returning fetched content to an agent.</p>
    <a href="https://fixture.test/related">Related article</a>
    <a href="https://fixture.test/other">Another link</a>
  </article>
</body>
</html>`;

export function articleWithLinks(links: string[]): string {
	const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("\n    ");
	return `<!DOCTYPE html>
<html lang="en"><head><title>Linked Fixture</title></head>
<body><article>
  <h1>Linked Fixture</h1>
  <p>Enough body text for Readability to extract this as an article rather than
     treating the page as JS-rendered with no content at all, which needs to be
     a reasonably long paragraph of prose to pass the extraction heuristics.</p>
  ${anchors}
</article></body></html>`;
}
