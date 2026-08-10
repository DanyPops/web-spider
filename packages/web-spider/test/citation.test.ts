import { describe, expect, it } from "vitest";
import { buildTextFragmentUrl } from "../src/citation.js";

describe("buildTextFragmentUrl — contract", () => {
	it("returns undefined for empty/whitespace-only text", () => {
		expect(buildTextFragmentUrl("https://example.com/a", "")).toBeUndefined();
		expect(buildTextFragmentUrl("https://example.com/a", "   ")).toBeUndefined();
	});

	it("builds a single text= directive for a short quote", () => {
		const url = buildTextFragmentUrl("https://example.com/a", "hello world");
		expect(url).toBe("https://example.com/a#:~:text=hello%20world");
	});

	it("strips buildSnippet()'s leading/trailing ellipsis truncation markers", () => {
		const url = buildTextFragmentUrl("https://example.com/a", "…hello world…");
		expect(url).toBe("https://example.com/a#:~:text=hello%20world");
	});

	it("percent-encodes the literal '-' character per the WICG spec (ambiguous with prefix-/-suffix delimiters)", () => {
		const url = buildTextFragmentUrl("https://example.com/a", "rate-limited");
		expect(url).toContain("%2D");
		expect(url).not.toMatch(/text=rate-limited/);
	});

	it("percent-encodes comma (ambiguous with the textStart,textEnd delimiter)", () => {
		const url = buildTextFragmentUrl("https://example.com/a", "cats, dogs");
		expect(url).toContain("%2C");
	});

	it("preserves a pre-existing element-id fragment as a fallback target", () => {
		const url = buildTextFragmentUrl("https://example.com/a#section-2", "hello world");
		expect(url).toBe("https://example.com/a#section-2:~:text=hello%20world");
	});

	it("uses a textStart,textEnd range for a long quote instead of encoding the whole thing", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
		const url = buildTextFragmentUrl("https://example.com/a", longText);
		expect(url).toBeDefined();
		expect(url).toContain(","); // textStart,textEnd range delimiter present
		// Full 20-word text must not appear encoded verbatim -- only the edges.
		expect(url!.length).toBeLessThan(encodeURIComponent(longText).length + 50);
	});

	it("a short quote (at or under the edge-word threshold) is encoded as a single exact text=, no range", () => {
		const shortText = "one two three four five six seven eight nine ten"; // 10 words
		const url = buildTextFragmentUrl("https://example.com/a", shortText);
		// No comma outside of the percent-encoded ones -- i.e. no literal "," delimiter in the fragment.
		const fragment = url!.split("#:~:")[1]!;
		expect(fragment.split(",").length).toBe(1);
	});
});
