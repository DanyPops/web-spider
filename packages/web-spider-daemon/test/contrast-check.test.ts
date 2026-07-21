import { describe, expect, test } from "bun:test";
import { defaultBrowserLauncher, PlaywrightSessionRegistry } from "../src/adapters/playwright-session-registry.ts";
import {
	checkContrast,
	checkContrastMeasurements,
	compositeOver,
	contrastRatio,
	isLargeText,
	measureContrastElements,
	parseCssColor,
	relativeLuminance,
	requiredRatio,
	SelectorNotFoundError,
	type ContrastMeasurement,
} from "../src/contrast-check.ts";

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const DARK_RED = { r: 139, g: 0, b: 0, a: 1 }; // #8b0000
const NEAR_BLACK = { r: 26, g: 26, b: 26, a: 1 }; // #1a1a1a — the real agent-deck bug's background

function measurement(overrides: Partial<ContrastMeasurement> = {}): ContrastMeasurement {
	return {
		selector: "#el",
		textSnippet: "text",
		foregroundCss: "rgb(0, 0, 0)",
		backgroundChainCss: ["rgb(255, 255, 255)"],
		fontSizePx: 16,
		fontWeight: 400,
		...overrides,
	};
}

describe("parseCssColor", () => {
	test("parses rgb() with default alpha 1", () => {
		expect(parseCssColor("rgb(139, 0, 0)")).toEqual({ r: 139, g: 0, b: 0, a: 1 });
	});

	test("parses rgba() with an explicit alpha", () => {
		expect(parseCssColor("rgba(26, 26, 26, 0.5)")).toEqual({ r: 26, g: 26, b: 26, a: 0.5 });
	});

	test("parses the literal keyword 'transparent' as alpha 0", () => {
		expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
	});

	test("returns undefined for an unparseable value rather than guessing", () => {
		expect(parseCssColor("not-a-color")).toBeUndefined();
		expect(parseCssColor("")).toBeUndefined();
	});
});

describe("compositeOver", () => {
	test("a single fully-opaque layer is returned as-is", () => {
		expect(compositeOver([DARK_RED])).toEqual({ ...DARK_RED, a: 1 });
	});

	test("fully transparent layers are skipped, falling through to the white canvas default", () => {
		expect(compositeOver([{ r: 0, g: 0, b: 0, a: 0 }])).toEqual(WHITE);
	});

	test("a semi-transparent layer blends with the canvas beneath it", () => {
		const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
		const result = compositeOver([halfBlack]);
		expect(result.r).toBeCloseTo(127.5, 0);
		expect(result.g).toBeCloseTo(127.5, 0);
		expect(result.b).toBeCloseTo(127.5, 0);
	});

	test("later layers paint over earlier ones", () => {
		expect(compositeOver([WHITE, DARK_RED])).toEqual({ ...DARK_RED, a: 1 });
	});
});

describe("relativeLuminance / contrastRatio", () => {
	test("black vs white is the maximum possible ratio, 21:1", () => {
		expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 0);
	});

	test("a color against itself is always 1:1", () => {
		expect(contrastRatio(DARK_RED, DARK_RED)).toBeCloseTo(1, 5);
	});

	test("argument order does not matter", () => {
		expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(contrastRatio(WHITE, BLACK), 10);
	});

	test("reproduces the real agent-deck bug: dark red (#8b0000) on near-black (#1a1a1a) is well below both WCAG thresholds", () => {
		const ratio = contrastRatio(DARK_RED, NEAR_BLACK);
		expect(ratio).toBeLessThan(3);
		expect(ratio).toBeCloseTo(1.74, 1);
	});
});

describe("isLargeText / requiredRatio — WCAG 2.1 SC 1.4.3 thresholds by text size", () => {
	test("24px normal weight is large text (3:1 threshold)", () => {
		expect(isLargeText(24, 400)).toBe(true);
		expect(requiredRatio(true)).toBe(3);
	});

	test("just under 24px normal weight is not large (4.5:1 threshold)", () => {
		expect(isLargeText(23.9, 400)).toBe(false);
		expect(requiredRatio(false)).toBe(4.5);
	});

	test("18.66px (~14pt) bold is large text", () => {
		expect(isLargeText(18.66, 700)).toBe(true);
	});

	test("18.66px bold-weight text below 700 is not large", () => {
		expect(isLargeText(18.66, 500)).toBe(false);
	});

	test("16px normal body text is never large regardless of weight", () => {
		expect(isLargeText(16, 900)).toBe(false);
	});
});

describe("checkContrastMeasurements — pure, no browser", () => {
	test("passes on compliant colors (black text on white)", () => {
		const result = checkContrastMeasurements([measurement()]);
		expect(result).toEqual({ passed: true, violations: [] });
	});

	test("flags a violation reproducing the real bug: dark-red text on a near-black background", () => {
		const result = checkContrastMeasurements([measurement({
			selector: ".observability-label",
			textSnippet: "sense-bus",
			foregroundCss: "rgb(139, 0, 0)",
			backgroundChainCss: ["rgb(26, 26, 26)"],
			fontSizePx: 14,
			fontWeight: 400,
		})]);
		expect(result.passed).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toMatchObject({ selector: ".observability-label", textSnippet: "sense-bus", required: 4.5, isLargeText: false });
		expect(result.violations[0]!.ratio).toBeLessThan(2);
	});

	test("resolves a transparent element background by walking up the ancestor chain", () => {
		const result = checkContrastMeasurements([measurement({
			foregroundCss: "rgb(139, 0, 0)",
			backgroundChainCss: ["transparent", "transparent", "rgb(26, 26, 26)"], // element and its parent are transparent; grandparent (e.g. <body>) is the real near-black canvas
		})]);
		expect(result.passed).toBe(false);
		expect(result.violations[0]!.ratio).toBeCloseTo(1.74, 1);
	});

	test("the same borderline ratio passes for large text but fails for small text — thresholds genuinely differ by size", () => {
		const midGrayOnWhite = { foregroundCss: "rgb(120, 120, 120)", backgroundChainCss: ["rgb(255, 255, 255)"] };
		const ratio = contrastRatio({ r: 120, g: 120, b: 120, a: 1 }, WHITE);
		expect(ratio).toBeGreaterThan(3);
		expect(ratio).toBeLessThan(4.5); // confirms this fixture actually straddles the two thresholds

		const large = checkContrastMeasurements([measurement({ ...midGrayOnWhite, fontSizePx: 24, fontWeight: 400 })]);
		expect(large.passed).toBe(true);

		const small = checkContrastMeasurements([measurement({ ...midGrayOnWhite, fontSizePx: 16, fontWeight: 400 })]);
		expect(small.passed).toBe(false);
	});

	test("an unparseable foreground color is skipped rather than reported as a false violation", () => {
		const result = checkContrastMeasurements([measurement({ foregroundCss: "currentColor" })]);
		expect(result).toEqual({ passed: true, violations: [] });
	});
});

describe("measureContrastElements / checkContrast — real browser, real rendered colors", () => {
	async function withPage<T>(html: string, run: (page: Awaited<ReturnType<PlaywrightSessionRegistry["page"]>>) => Promise<T>): Promise<T> {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("contrast-check-e2e");
		try {
			const page = await registry.page("contrast-check-e2e");
			await page.goto(`data:text/html,${encodeURIComponent(html)}`);
			return await run(page);
		} finally {
			await registry.close("contrast-check-e2e");
		}
	}

	test("passing case: black text on a white background measures as compliant", async () => {
		const html = `<!DOCTYPE html><html><body style="background: white; margin:0;">
			<p id="label" style="color: #000000;">Readable label</p>
		</body></html>`;
		await withPage(html, async (page) => {
			const result = await checkContrast(page, ["#label"]);
			expect(result.passed).toBe(true);
		});
	}, 30_000);

	test("failing case: reproduces the real agent-deck bug — dark-red text on a near-black background, inherited from an ancestor", async () => {
		const html = `<!DOCTYPE html><html><body style="background: #1a1a1a; margin:0;">
			<div class="observability-tile">
				<span id="bus-label" style="color: #8b0000;">sense-bus</span>
			</div>
		</body></html>`;
		await withPage(html, async (page) => {
			const result = await checkContrast(page, ["#bus-label"]);
			expect(result.passed).toBe(false);
			expect(result.violations).toHaveLength(1);
			expect(result.violations[0]).toMatchObject({ selector: "#bus-label", textSnippet: "sense-bus", required: 4.5 });
			expect(result.violations[0]!.ratio).toBeLessThan(2);
		});
	}, 30_000);

	test("resolves a genuinely transparent element background against the real ancestor chain, not a guess", async () => {
		const html = `<!DOCTYPE html><html><body style="background: #1a1a1a; margin:0;">
			<div style="background: transparent;">
				<span id="nested" style="color: #8b0000; background: transparent;">nested</span>
			</div>
		</body></html>`;
		await withPage(html, async (page) => {
			const result = await checkContrast(page, ["#nested"]);
			expect(result.passed).toBe(false);
			expect(result.violations[0]!.ratio).toBeLessThan(2);
		});
	}, 30_000);

	test("measureContrastElements throws SelectorNotFoundError for a selector matching nothing", async () => {
		const html = `<!DOCTYPE html><html><body><div id="real">x</div></body></html>`;
		await withPage(html, async (page) => {
			await expect(measureContrastElements(page, ["#ghost"])).rejects.toThrow(SelectorNotFoundError);
		});
	}, 30_000);
});
