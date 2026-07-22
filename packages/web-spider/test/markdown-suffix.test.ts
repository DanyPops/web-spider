import { describe, expect, it } from "vitest";
import { deriveMarkdownVariantUrl, probeMarkdownVariant } from "../src/markdown-suffix.js";
import type { IHttpClient } from "../src/ports.js";

describe("deriveMarkdownVariantUrl", () => {
	it("replaces a .html extension with .md", () => {
		expect(deriveMarkdownVariantUrl("https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html")).toBe(
			"https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.md",
		);
	});

	it("replaces a .htm extension with .md", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/page.htm")).toBe("https://example.com/page.md");
	});

	it("is case-insensitive on the extension", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/page.HTML")).toBe("https://example.com/page.md");
	});

	it("appends .md to an extensionless path", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/docs/guide")).toBe("https://example.com/docs/guide.md");
	});

	it("strips a trailing slash before appending .md", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/docs/guide/")).toBe("https://example.com/docs/guide.md");
	});

	it("returns null for a URL that is already .md", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/page.md")).toBeNull();
	});

	it("returns null for an unrelated extension (.pdf, .json) -- not this convention's shape", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/file.pdf")).toBeNull();
		expect(deriveMarkdownVariantUrl("https://example.com/data.json")).toBeNull();
	});

	it("preserves query strings and hash fragments", () => {
		expect(deriveMarkdownVariantUrl("https://example.com/page.html?foo=bar#section")).toBe(
			"https://example.com/page.md?foo=bar#section",
		);
	});

	it("returns null for an invalid URL rather than throwing", () => {
		expect(deriveMarkdownVariantUrl("not a url")).toBeNull();
	});
});

function stubClient(routes: Record<string, { status: number; contentType: string | null; body: string }>): IHttpClient {
	return {
		async fetch(req) {
			const route = routes[req.url];
			if (!route) return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			return {
				ok: route.status >= 200 && route.status < 300,
				status: route.status,
				statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? route.contentType : null) },
				text: async () => route.body,
				arrayBuffer: async () => new TextEncoder().encode(route.body).buffer as ArrayBuffer,
			};
		},
	};
}

describe("probeMarkdownVariant", () => {
	it("finds a real .md sibling of the requested page", async () => {
		const httpClient = stubClient({
			"https://docs.aws.amazon.com/x/Welcome.md": { status: 200, contentType: "text/markdown; charset=utf-8", body: "# Welcome\n\nReal markdown content." },
		});
		const result = await probeMarkdownVariant("https://docs.aws.amazon.com/x/Welcome.html", httpClient);
		expect(result?.url).toBe("https://docs.aws.amazon.com/x/Welcome.md");
		expect(result?.content).toContain("# Welcome");
	});

	it("returns null when there is no sensible .md variant to try (no network call made)", async () => {
		let called = false;
		const httpClient: IHttpClient = { async fetch() { called = true; throw new Error("should not be called"); } };
		expect(await probeMarkdownVariant("https://example.com/file.pdf", httpClient)).toBeNull();
		expect(called).toBe(false);
	});

	it("returns null on a real 404", async () => {
		const httpClient = stubClient({});
		expect(await probeMarkdownVariant("https://example.com/page.html", httpClient)).toBeNull();
	});

	it("returns null for a 200 text/html response -- redirected back to HTML, not a real .md", async () => {
		const httpClient = stubClient({
			"https://example.com/page.md": { status: 200, contentType: "text/html; charset=utf-8", body: "<html>nope</html>" },
		});
		expect(await probeMarkdownVariant("https://example.com/page.html", httpClient)).toBeNull();
	});

	it("returns null for an empty body", async () => {
		const httpClient = stubClient({
			"https://example.com/page.md": { status: 200, contentType: "text/markdown", body: "   " },
		});
		expect(await probeMarkdownVariant("https://example.com/page.html", httpClient)).toBeNull();
	});
});
