/**
 * TDD tests for toMarkdown() keepImages flag.
 */

import { describe, expect, it } from "vitest";
import { toMarkdown } from "../src/convert.js";

describe("toMarkdown() keepImages flag", () => {
	it("1. default strips images — no src or alt in output", () => {
		const md = toMarkdown('<img src="a.png" alt="A nice photo">');
		expect(md).not.toContain("a.png");
		expect(md).not.toContain("A nice photo");
		expect(md.trim()).toBe("");
	});

	it("2. keepImages: true preserves image as markdown", () => {
		const md = toMarkdown('<img src="a.png" alt="A nice photo">', { keepImages: true });
		expect(md).toContain("a.png");
		expect(md).toContain("A nice photo");
		expect(md).toMatch(/!\[.*\]\(a\.png\)/);
	});

	it("3. keepImages: true with missing alt produces empty alt", () => {
		const md = toMarkdown('<img src="a.png">', { keepImages: true });
		expect(md).toContain("a.png");
		expect(md).toMatch(/!\[\]\(a\.png\)/);
	});

	it("4. keepImages: false explicitly strips images (same as default)", () => {
		const md = toMarkdown('<img src="b.jpg" alt="Photo">', { keepImages: false });
		expect(md).not.toContain("b.jpg");
	});

	it("5. keepImages does not affect surrounding text content", () => {
		const html = '<p>Before</p><img src="x.png" alt="X"><p>After</p>';

		const stripped = toMarkdown(html);
		expect(stripped).toContain("Before");
		expect(stripped).toContain("After");
		expect(stripped).not.toContain("x.png");

		const kept = toMarkdown(html, { keepImages: true });
		expect(kept).toContain("Before");
		expect(kept).toContain("After");
		expect(kept).toContain("x.png");
	});

	it("6. multiple images — all stripped when keepImages: false", () => {
		const html = '<img src="1.jpg" alt="One"><img src="2.png" alt="Two">';
		const md = toMarkdown(html);
		expect(md).not.toContain("1.jpg");
		expect(md).not.toContain("2.png");
	});

	it("7. multiple images — all preserved when keepImages: true", () => {
		const html = '<img src="1.jpg" alt="One"><img src="2.png" alt="Two">';
		const md = toMarkdown(html, { keepImages: true });
		expect(md).toContain("1.jpg");
		expect(md).toContain("2.png");
	});

	it("8. absolute URL src is preserved as-is", () => {
		const md = toMarkdown(
			'<img src="https://example.com/photo.jpg" alt="Remote">',
			{ keepImages: true },
		);
		expect(md).toContain("https://example.com/photo.jpg");
	});
});
