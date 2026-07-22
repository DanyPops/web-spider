/**
 * Integration tests: spider()'s preferGitHub option end to end, not just
 * the standalone github.ts units (github.test.ts). No real network.
 */
import { describe, expect, it } from "vitest";
import type { IHttpClient } from "../src/ports.js";
import { spider } from "../src/spider.js";

function stubClient(jsonRoutes: Record<string, unknown>, htmlRoutes: Record<string, string> = {}): IHttpClient {
	return {
		async fetch(req) {
			if (req.url in jsonRoutes) {
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
					text: async () => JSON.stringify(jsonRoutes[req.url]),
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			if (req.url in htmlRoutes) {
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => htmlRoutes[req.url],
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			}
			return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
		},
	};
}

describe("spider() — preferGitHub", () => {
	it("queries the real API for a repo instead of scraping the rendered page", async () => {
		const httpClient = stubClient({
			"https://api.github.com/repos/DanyPops/web-spider": { full_name: "DanyPops/web-spider", description: "desc", stargazers_count: 3, default_branch: "main" },
			"https://api.github.com/repos/DanyPops/web-spider/readme": { encoding: "base64", content: Buffer.from("# Web Spider\n\nReal README.").toString("base64") },
		});
		const page = await spider("https://github.com/DanyPops/web-spider", { httpClient, preferGitHub: true });
		expect(page.url).toBe("https://github.com/DanyPops/web-spider"); // unchanged -- same resource, different mechanism
		expect(page.viaStrategy).toBe("github");
		expect(page.title).toBe("DanyPops/web-spider");
		expect(page.markdown).toContain("Real README.");
	});

	it("queries the real API for an issue", async () => {
		const httpClient = stubClient({
			"https://api.github.com/repos/o/r/issues/1": { number: 1, title: "Bug report", state: "open", body: "Real body content.", user: { login: "alice" }, labels: [], comments: 0 },
		});
		const page = await spider("https://github.com/o/r/issues/1", { httpClient, preferGitHub: true });
		expect(page.viaStrategy).toBe("github");
		expect(page.title).toBe("Bug report (#1)");
		expect(page.markdown).toContain("Real body content.");
	});

	it("falls through to the normal fetch path unchanged for a non-github.com URL", async () => {
		const httpClient = stubClient({}, {
			"https://gitlab.com/owner/repo": "<html><head><title>GitLab Repo</title></head><body><article><p>Real content, long enough for Readability's extraction heuristics.</p></article></body></html>",
		});
		const page = await spider("https://gitlab.com/owner/repo", { httpClient, preferGitHub: true });
		expect(page.viaStrategy).toBeUndefined();
		expect(page.title).toBe("GitLab Repo");
	});

	it("falls through unchanged for a github.com URL shape this strategy doesn't cover (blob/wiki)", async () => {
		const httpClient = stubClient({}, {
			"https://github.com/o/r/blob/main/README.md": "<html><head><title>README.md at main</title></head><body><article><p>Real rendered blob page content, long enough for extraction.</p></article></body></html>",
		});
		const page = await spider("https://github.com/o/r/blob/main/README.md", { httpClient, preferGitHub: true });
		expect(page.viaStrategy).toBeUndefined();
	});

	it("falls through when the API call fails (rate limited, not found)", async () => {
		const httpClient = stubClient({}, {
			"https://github.com/o/nonexistent": "<html><head><title>404</title></head><body><article><p>Real 404 page content, long enough for the extraction heuristics to treat it as a body.</p></article></body></html>",
		});
		const page = await spider("https://github.com/o/nonexistent", { httpClient, preferGitHub: true });
		expect(page.viaStrategy).toBeUndefined();
	});

	it("is fully opt-in: default behavior never probes the GitHub API at all", async () => {
		let probedApi = false;
		const httpClient: IHttpClient = {
			async fetch(req) {
				if (req.url.includes("api.github.com")) probedApi = true;
				return {
					ok: true, status: 200, statusText: "OK",
					headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
					text: async () => "<html><head><title>Hi</title></head><body><article><p>Some real content here, long enough to be treated as a genuine article body.</p></article></body></html>",
					arrayBuffer: async () => new ArrayBuffer(0),
				};
			},
		};
		const page = await spider("https://github.com/o/r", { httpClient });
		expect(probedApi).toBe(false);
		expect(page.viaStrategy).toBeUndefined();
	});

	it("passes an explicit githubToken through as a Bearer Authorization header", async () => {
		let capturedAuth: string | null = null;
		const httpClient: IHttpClient = {
			async fetch(req) {
				const headers = req.headers as Record<string, string> | undefined;
				capturedAuth = headers?.["Authorization"] ?? null;
				if (req.url === "https://api.github.com/repos/o/r") {
					return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, text: async () => JSON.stringify({ full_name: "o/r" }), arrayBuffer: async () => new ArrayBuffer(0) };
				}
				return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			},
		};
		await spider("https://github.com/o/r", { httpClient, preferGitHub: true, githubToken: "my-secret-token" });
		expect(capturedAuth).toBe("Bearer my-secret-token");
	});
});
