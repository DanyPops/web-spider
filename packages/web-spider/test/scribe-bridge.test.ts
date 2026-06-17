import { describe, expect, it } from "vitest";
import type { SpideredPage } from "../src/types.js";
import { pageToRecords, pagesToNDJSON } from "../src/scribe-bridge.js";

function fakePage(overrides: Partial<SpideredPage> = {}): SpideredPage {
	return {
		url: "https://example.com/docs/auth",
		domain: "example.com",
		fetchedAt: "2026-06-17T10:00:00Z",
		title: "Authentication Guide",
		description: "How to set up JWT auth.",
		author: "Alice",
		publishedAt: "2026-06-01",
		lang: "en",
		tags: ["auth", "security"],
		wordCount: 500,
		readingTimeMinutes: 2,
		headings: [
			{ level: 1, text: "Auth Guide" },
			{ level: 2, text: "JWT Setup" },
		],
		chunks: [
			{ id: "https://example.com/docs/auth#chunk-0", index: 0, heading: "Auth Guide", text: "JWT is a token standard.", wordCount: 100, contentType: "text" },
			{ id: "https://example.com/docs/auth#chunk-1", index: 1, heading: "JWT Setup", text: "Install the library...", wordCount: 80, contentType: "text" },
		],
		links: [
			{ href: "https://example.com/docs/tokens", text: "Token docs", isExternal: false, rel: "body" },
			{ href: "https://jwt.io", text: "JWT.io", isExternal: true, rel: "body" },
			{ href: "https://example.com/nav", text: "Home", isExternal: false, rel: "nav" },
		],
		markdown: "# Auth Guide\n\nJWT is a token standard.\n\n## JWT Setup\n\nInstall the library...",
		...overrides,
	};
}

describe("scribe-bridge", () => {
	it("produces node record for page", () => {
		const records = pageToRecords(fakePage());
		const page = records.find((r) => r.type === "node" && r.kind === "knowledge.source");
		expect(page).toBeDefined();
		expect(page!.title).toBe("Authentication Guide");
		expect(page!.id).toBe("https://example.com/docs/auth");
		expect((page!.labels as string[]).includes("source:web-spider")).toBe(true);
		expect((page!.labels as string[]).includes("domain:example.com")).toBe(true);
		expect((page!.labels as string[]).includes("tag:auth")).toBe(true);
	});

	it("produces chunk nodes with parent_of edges", () => {
		const records = pageToRecords(fakePage());
		const chunks = records.filter((r) => r.type === "node" && r.kind === "support.paragraph");
		expect(chunks).toHaveLength(2);
		expect(chunks[0].id).toBe("https://example.com/docs/auth#chunk-0");

		const parentEdges = records.filter((r) => r.type === "edge" && r.relation === "parent_of");
		expect(parentEdges).toHaveLength(2);
		expect(parentEdges[0].from).toBe("https://example.com/docs/auth");
		expect(parentEdges[0].to).toBe("https://example.com/docs/auth#chunk-0");
	});

	it("produces cites edges for internal body links only", () => {
		const records = pageToRecords(fakePage());
		const cites = records.filter((r) => r.type === "edge" && r.relation === "cites");
		expect(cites).toHaveLength(1);
		expect(cites[0].to).toBe("https://example.com/docs/tokens");
	});

	it("does not produce edges for external or nav links", () => {
		const records = pageToRecords(fakePage());
		const allEdges = records.filter((r) => r.type === "edge");
		const externalOrNav = allEdges.filter(
			(e) => e.to === "https://jwt.io" || e.to === "https://example.com/nav",
		);
		expect(externalOrNav).toHaveLength(0);
	});

	it("uses canonicalUrl as ID when available", () => {
		const records = pageToRecords(fakePage({ canonicalUrl: "https://example.com/canonical" }));
		const page = records.find((r) => r.type === "node" && r.kind === "knowledge.source");
		expect(page!.id).toBe("https://example.com/canonical");
	});

	it("pagesToNDJSON produces valid NDJSON with meta", () => {
		const ndjson = pagesToNDJSON([fakePage()]);
		const lines = ndjson.split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);

		const meta = JSON.parse(lines[lines.length - 1]);
		expect(meta.type).toBe("meta");
		expect(meta.source).toBe("web-spider");
		expect(meta.total_nodes).toBeGreaterThan(0);
	});

	it("builds sections with description, content, outline", () => {
		const records = pageToRecords(fakePage());
		const page = records.find((r) => r.type === "node" && r.kind === "knowledge.source");
		const sections = page!.sections as Array<{ name: string; text: string }>;
		const names = sections.map((s) => s.name);
		expect(names).toContain("description");
		expect(names).toContain("content");
		expect(names).toContain("outline");
	});

	it("handles empty page gracefully", () => {
		const records = pageToRecords(
			fakePage({
				chunks: [],
				links: [],
				headings: [],
				description: "",
				markdown: "",
			}),
		);
		const nodes = records.filter((r) => r.type === "node");
		expect(nodes).toHaveLength(1);
		const edges = records.filter((r) => r.type === "edge");
		expect(edges).toHaveLength(0);
	});
});
