/**
 * Unit tests for probeLlmsTxt — no real network, stub IHttpClient, matching
 * the existing spider-content-type.test.ts pattern.
 */
import { describe, expect, it } from "vitest";
import { probeLlmsTxt } from "../src/llms-txt.js";
import type { IHttpClient } from "../src/ports.js";

function stubClient(handler: (url: string) => { ok: boolean; status: number; contentType: string | null; body: string }): IHttpClient {
	return {
		async fetch(req) {
			const { ok, status, contentType, body } = handler(req.url);
			return {
				ok,
				status,
				statusText: ok ? "OK" : "Not Found",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
				text: async () => body,
				arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
			};
		},
	};
}

describe("probeLlmsTxt", () => {
	it("finds a real llms.txt at the target URL's origin", async () => {
		const httpClient = stubClient((url) => {
			if (url === "https://docs.example.com/llms.txt") {
				return { ok: true, status: 200, contentType: "text/plain; charset=utf-8", body: "# Example Docs\n\n- [Guide](https://docs.example.com/guide)" };
			}
			return { ok: false, status: 404, contentType: null, body: "" };
		});
		const result = await probeLlmsTxt("https://docs.example.com/some/deep/page", httpClient);
		expect(result).not.toBeNull();
		expect(result?.url).toBe("https://docs.example.com/llms.txt");
		expect(result?.variant).toBe("llms.txt");
		expect(result?.content).toContain("# Example Docs");
	});

	it("probes the origin, not a relative path under the requested URL", async () => {
		let requested = "";
		const httpClient = stubClient((url) => {
			requested = url;
			return { ok: true, status: 200, contentType: "text/plain", body: "index" };
		});
		await probeLlmsTxt("https://example.com/a/b/c?query=1#frag", httpClient);
		expect(requested).toBe("https://example.com/llms.txt");
	});

	it("returns null for a real 404 (no llms.txt at all)", async () => {
		const httpClient = stubClient(() => ({ ok: false, status: 404, contentType: null, body: "" }));
		expect(await probeLlmsTxt("https://example.com", httpClient)).toBeNull();
	});

	it("returns null for a 200 text/html response -- SPA soft-404, not a real llms.txt", async () => {
		const httpClient = stubClient(() => ({ ok: true, status: 200, contentType: "text/html; charset=utf-8", body: "<html><body>App shell</body></html>" }));
		expect(await probeLlmsTxt("https://example.com", httpClient)).toBeNull();
	});

	it("returns null for an empty (whitespace-only) body", async () => {
		const httpClient = stubClient(() => ({ ok: true, status: 200, contentType: "text/plain", body: "   \n  " }));
		expect(await probeLlmsTxt("https://example.com", httpClient)).toBeNull();
	});

	it("returns null for an invalid URL rather than throwing", async () => {
		const httpClient = stubClient(() => ({ ok: true, status: 200, contentType: "text/plain", body: "x" }));
		expect(await probeLlmsTxt("not a url", httpClient)).toBeNull();
	});

	it("returns null when the request throws (network error, timeout)", async () => {
		const httpClient: IHttpClient = { async fetch() { throw new Error("network down"); } };
		expect(await probeLlmsTxt("https://example.com", httpClient)).toBeNull();
	});

	it("falls back to llms-full.txt only when includeFullVariant is set and llms.txt is missing", async () => {
		const httpClient = stubClient((url) => {
			if (url === "https://example.com/llms.txt") return { ok: false, status: 404, contentType: null, body: "" };
			if (url === "https://example.com/llms-full.txt") return { ok: true, status: 200, contentType: "text/markdown", body: "full content here" };
			return { ok: false, status: 404, contentType: null, body: "" };
		});
		const withoutFull = await probeLlmsTxt("https://example.com", httpClient);
		expect(withoutFull).toBeNull();

		const withFull = await probeLlmsTxt("https://example.com", httpClient, { includeFullVariant: true });
		expect(withFull?.variant).toBe("llms-full.txt");
		expect(withFull?.content).toBe("full content here");
	});

	it("prefers llms.txt over llms-full.txt when both exist and includeFullVariant is set", async () => {
		const httpClient = stubClient((url) => {
			if (url === "https://example.com/llms.txt") return { ok: true, status: 200, contentType: "text/plain", body: "index" };
			if (url === "https://example.com/llms-full.txt") return { ok: true, status: 200, contentType: "text/plain", body: "full" };
			return { ok: false, status: 404, contentType: null, body: "" };
		});
		const result = await probeLlmsTxt("https://example.com", httpClient, { includeFullVariant: true });
		expect(result?.variant).toBe("llms.txt");
		expect(result?.content).toBe("index");
	});
});
