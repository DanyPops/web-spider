import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import type { LeanPage, SpideredPage } from "../src/types.js";
import { toLean } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): SpideredPage {
	const raw = readFileSync(join(__dirname, "../fixtures", name), "utf8");
	return JSON.parse(raw) as SpideredPage;
}

const guide = loadFixture("guide-ai-agents-web-scraping.json");

describe("toLean", () => {
	let lean: LeanPage;

	it("produces a lean page without error", () => {
		lean = toLean(guide);
		expect(lean).toBeDefined();
	});

	it("sets view discriminant to 'lean'", () => {
		lean = toLean(guide);
		expect(lean.view).toBe("lean");
	});

	it("preserves all identity and metadata fields", () => {
		lean = toLean(guide);
		expect(lean.url).toBe(guide.url);
		expect(lean.domain).toBe(guide.domain);
		expect(lean.title).toBe(guide.title);
		expect(lean.description).toBe(guide.description);
		expect(lean.author).toBe(guide.author);
		expect(lean.lang).toBe(guide.lang);
		expect(lean.wordCount).toBe(guide.wordCount);
		expect(lean.readingTimeMinutes).toBe(guide.readingTimeMinutes);
	});

	it("converts headings to flat markdown strings", () => {
		lean = toLean(guide);
		// Fixture has all level-2 headings
		expect(lean.headings).toBeInstanceOf(Array);
		expect(lean.headings.length).toBe(guide.headings.length);
		for (const h of lean.headings) {
			expect(typeof h).toBe("string");
			expect(h).toMatch(/^#{1,3} .+/);
		}
		// Spot-check first heading
		const first = guide.headings[0];
		expect(lean.headings[0]).toBe(`${"#".repeat(first.level)} ${first.text}`);
	});

	it("strips isExternal from links", () => {
		lean = toLean(guide);
		expect(lean.links.length).toBeGreaterThan(0);
		for (const link of lean.links) {
			expect(link).toHaveProperty("href");
			expect(link).toHaveProperty("text");
			expect(link).not.toHaveProperty("isExternal");
		}
	});

	it("passes tags through from source page", () => {
		lean = toLean(guide);
		expect(Array.isArray(lean.tags)).toBe(true);
	});

	it("passes canonicalUrl when present", () => {
		const withCanonical = { ...guide, canonicalUrl: "https://example.com/canonical" };
		const l = toLean(withCanonical);
		expect(l.canonicalUrl).toBe("https://example.com/canonical");
	});

	it("omits canonicalUrl when absent", () => {
		const withoutCanonical = { ...guide };
		delete (withoutCanonical as Partial<typeof guide>).canonicalUrl;
		const l = toLean(withoutCanonical);
		expect(l.canonicalUrl).toBeUndefined();
	});

	it("sets chunkCount from the source chunks array", () => {
		lean = toLean(guide);
		expect(lean.chunkCount).toBe(guide.chunks.length);
		expect(lean.chunkCount).toBeGreaterThan(0);
	});

	it("omits chunks and markdown fields", () => {
		lean = toLean(guide);
		expect(lean).not.toHaveProperty("chunks");
		expect(lean).not.toHaveProperty("markdown");
	});

	it("is materially smaller than the full page", () => {
		lean = toLean(guide);
		const fullSize = JSON.stringify(guide).length;
		const leanSize = JSON.stringify(lean).length;
		// Lean should be less than 30% the size of full.
		// Links (up to 200) still carry href+text so the floor isn't zero,
		// but chunks and markdown — the two biggest fields — are gone.
		expect(leanSize).toBeLessThan(fullSize * 0.3);
	});
});
