/**
 * Unit tests for the GitHub API strategy — no real network, stub
 * IHttpClient. Field shapes (full_name, stargazers_count, pull_request
 * presence, base64 README encoding, etc.) were verified against the real
 * GitHub API before writing this module.
 */
import { describe, expect, it } from "vitest";
import { parseGitHubUrl, queryGitHub } from "../src/github.js";
import type { IHttpClient } from "../src/ports.js";

describe("parseGitHubUrl", () => {
	it("parses a bare repo URL", () => {
		expect(parseGitHubUrl("https://github.com/DanyPops/web-spider")).toEqual({ owner: "DanyPops", repo: "web-spider", kind: "repo" });
	});

	it("parses an issue URL", () => {
		expect(parseGitHubUrl("https://github.com/facebook/react/issues/1")).toEqual({ owner: "facebook", repo: "react", kind: "issue", number: 1 });
	});

	it("parses a pull request URL (same shape as issues -- GitHub's own API treats them the same way)", () => {
		expect(parseGitHubUrl("https://github.com/facebook/react/pull/1")).toEqual({ owner: "facebook", repo: "react", kind: "issue", number: 1 });
	});

	it("returns null for a non-github.com host", () => {
		expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
	});

	it("returns null for blob/file browsing, wiki, and other non-repo/issue shapes", () => {
		expect(parseGitHubUrl("https://github.com/DanyPops/web-spider/blob/main/README.md")).toBeNull();
		expect(parseGitHubUrl("https://github.com/DanyPops/web-spider/wiki/Home")).toBeNull();
		expect(parseGitHubUrl("https://github.com/DanyPops/web-spider/releases")).toBeNull();
	});

	it("returns null for github.com's own marketing/root pages", () => {
		expect(parseGitHubUrl("https://github.com/")).toBeNull();
		expect(parseGitHubUrl("https://github.com/features")).toBeNull();
	});

	it("returns null for a non-numeric issue-shaped path", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo/issues/not-a-number")).toBeNull();
	});

	it("returns null for an invalid URL rather than throwing", () => {
		expect(parseGitHubUrl("not a url")).toBeNull();
	});
});

function apiClient(routes: Record<string, unknown>, opts: { capturedAuth?: { value: string | null } } = {}): IHttpClient {
	return {
		async fetch(req) {
			if (opts.capturedAuth) {
				const headers = req.headers as Record<string, string> | undefined;
				opts.capturedAuth.value = headers?.["Authorization"] ?? null;
			}
			const body = routes[req.url];
			if (body === undefined) {
				return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
			}
			return {
				ok: true, status: 200, statusText: "OK",
				headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
				text: async () => JSON.stringify(body),
				arrayBuffer: async () => new ArrayBuffer(0),
			};
		},
	};
}

describe("queryGitHub — repo", () => {
	it("builds a structured summary + README markdown", async () => {
		const httpClient = apiClient({
			"https://api.github.com/repos/DanyPops/web-spider": {
				full_name: "DanyPops/web-spider", description: "AI-agent-friendly web spider", stargazers_count: 5,
				language: "TypeScript", topics: ["ai", "crawler"], default_branch: "main", html_url: "https://github.com/DanyPops/web-spider",
			},
			"https://api.github.com/repos/DanyPops/web-spider/readme": {
				encoding: "base64", content: Buffer.from("# Web Spider\n\nReal README content.").toString("base64"),
			},
		});
		const result = await queryGitHub("https://github.com/DanyPops/web-spider", httpClient);
		expect(result?.kind).toBe("repo");
		expect(result?.title).toBe("DanyPops/web-spider");
		expect(result?.markdown).toContain("⭐ 5 stars");
		expect(result?.markdown).toContain("Language: TypeScript");
		expect(result?.markdown).toContain("Topics: ai, crawler");
		expect(result?.markdown).toContain("Real README content.");
	});

	it("handles a repo with no README gracefully", async () => {
		const httpClient = apiClient({
			"https://api.github.com/repos/o/r": { full_name: "o/r", stargazers_count: 0, default_branch: "main" },
		});
		const result = await queryGitHub("https://github.com/o/r", httpClient);
		expect(result?.markdown).toContain("*No README found.*");
	});

	it("notes when a repository is archived", async () => {
		const httpClient = apiClient({
			"https://api.github.com/repos/o/r": { full_name: "o/r", archived: true, default_branch: "main" },
		});
		const result = await queryGitHub("https://github.com/o/r", httpClient);
		expect(result?.markdown).toContain("archived");
	});

	it("returns null when the repo doesn't exist (404)", async () => {
		const httpClient = apiClient({});
		expect(await queryGitHub("https://github.com/nope/nope", httpClient)).toBeNull();
	});
});

describe("queryGitHub — issues and pull requests", () => {
	it("builds a structured issue summary", async () => {
		const httpClient = apiClient({
			"https://api.github.com/repos/o/r/issues/1": {
				number: 1, title: "Something is broken", state: "open", body: "Steps to reproduce...",
				user: { login: "alice" }, labels: [{ name: "bug" }, { name: "priority:high" }], comments: 3,
				html_url: "https://github.com/o/r/issues/1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z",
			},
		});
		const result = await queryGitHub("https://github.com/o/r/issues/1", httpClient);
		expect(result?.kind).toBe("issue");
		expect(result?.title).toBe("Something is broken (#1)");
		expect(result?.markdown).toContain("Kind: Issue");
		expect(result?.markdown).toContain("Author: alice");
		expect(result?.markdown).toContain("Labels: bug, priority:high");
		expect(result?.markdown).toContain("Steps to reproduce...");
	});

	it("recognizes a pull request via the pull_request field's presence, matching GitHub's own API shape", async () => {
		const httpClient = apiClient({
			"https://api.github.com/repos/o/r/issues/1": {
				number: 1, title: "Fix the thing", state: "closed", body: "This PR fixes it.",
				user: { login: "bob" }, labels: [], comments: 0, pull_request: { merged_at: "2024-01-03T00:00:00Z" },
				html_url: "https://github.com/o/r/pull/1",
			},
		});
		const result = await queryGitHub("https://github.com/o/r/pull/1", httpClient);
		expect(result?.kind).toBe("pull");
		expect(result?.markdown).toContain("Kind: Pull Request");
	});

	it("returns null for a nonexistent issue (404)", async () => {
		const httpClient = apiClient({});
		expect(await queryGitHub("https://github.com/o/r/issues/999", httpClient)).toBeNull();
	});
});

describe("queryGitHub — auth", () => {
	it("sends no Authorization header when no token is configured", async () => {
		const captured = { value: null as string | null };
		const httpClient = apiClient({ "https://api.github.com/repos/o/r": { full_name: "o/r" } }, { capturedAuth: captured });
		await queryGitHub("https://github.com/o/r", httpClient);
		expect(captured.value).toBeNull();
	});

	it("sends a Bearer Authorization header when an explicit token option is given", async () => {
		const captured = { value: null as string | null };
		const httpClient = apiClient({ "https://api.github.com/repos/o/r": { full_name: "o/r" } }, { capturedAuth: captured });
		await queryGitHub("https://github.com/o/r", httpClient, { token: "secret-token-value" });
		expect(captured.value).toBe("Bearer secret-token-value");
	});

	it("falls back to GITHUB_TOKEN env var when no explicit token option is given", async () => {
		const original = process.env["GITHUB_TOKEN"];
		process.env["GITHUB_TOKEN"] = "env-token-value";
		try {
			const captured = { value: null as string | null };
			const httpClient = apiClient({ "https://api.github.com/repos/o/r": { full_name: "o/r" } }, { capturedAuth: captured });
			await queryGitHub("https://github.com/o/r", httpClient);
			expect(captured.value).toBe("Bearer env-token-value");
		} finally {
			if (original === undefined) delete process.env["GITHUB_TOKEN"];
			else process.env["GITHUB_TOKEN"] = original;
		}
	});

	it("an explicit token option takes precedence over the env var", async () => {
		const original = process.env["GITHUB_TOKEN"];
		process.env["GITHUB_TOKEN"] = "env-token-value";
		try {
			const captured = { value: null as string | null };
			const httpClient = apiClient({ "https://api.github.com/repos/o/r": { full_name: "o/r" } }, { capturedAuth: captured });
			await queryGitHub("https://github.com/o/r", httpClient, { token: "explicit-token" });
			expect(captured.value).toBe("Bearer explicit-token");
		} finally {
			if (original === undefined) delete process.env["GITHUB_TOKEN"];
			else process.env["GITHUB_TOKEN"] = original;
		}
	});
});
