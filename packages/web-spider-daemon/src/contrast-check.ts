/**
 * WCAG contrast-ratio checker — the capability that directly catches the
 * bug that motivated this whole toolkit: near-invisible dark-red text on a
 * near-black background in agent-deck's Observability tab.
 *
 * Thresholds reused verbatim from doc
 * design-tokens-red-hat-informed-not-red-hat-branded-rm7c: 4.5:1 for text
 * smaller than 18pt (24px), 3:1 for large text (18pt/24px+, or 14pt/~18.67px+
 * when bold — WCAG 2.1 SC 1.4.3's full "large-scale text" definition, which
 * the doc's own "18pt+" phrasing summarizes) and informative icons/graphics.
 *
 * Architecture mirrors layout-check.ts: DOM traversal (getComputedStyle,
 * walking the ancestor chain to resolve a transparent background to what's
 * actually rendered behind it) happens inside the browser via
 * SessionPage.evaluate(), returning raw CSS color strings; all color
 * parsing, alpha compositing, luminance, and ratio math is pure Node-side
 * logic, directly unit-testable without a browser.
 */
import type { SessionPage } from "./ports/session-registry.ts";

export interface ColorRGBA {
	r: number;
	g: number;
	b: number;
	/** 0 (fully transparent) – 1 (fully opaque). */
	a: number;
}

const RGB_PATTERN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu;

/** Parses a getComputedStyle()-normalized color string ("rgb(r, g, b)" / "rgba(r, g, b, a)" / "transparent"). Returns undefined for anything else rather than guessing. */
export function parseCssColor(css: string): ColorRGBA | undefined {
	const trimmed = css.trim();
	if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	const match = RGB_PATTERN.exec(trimmed);
	if (!match) return undefined;
	const [, r, g, b, a] = match;
	return { r: Number(r), g: Number(g), b: Number(b), a: a === undefined ? 1 : Number(a) };
}

/**
 * Composites a stack of colors painted bottom-to-top (layers[0] painted
 * first/furthest back, layers[last] painted last/frontmost) over an opaque
 * white canvas — the browser's own default paint surface — using standard
 * "over" alpha compositing. Returns a fully opaque color (a:1).
 */
export function compositeOver(layers: ColorRGBA[]): ColorRGBA {
	let result: ColorRGBA = { r: 255, g: 255, b: 255, a: 1 };
	for (const layer of layers) {
		if (layer.a <= 0) continue;
		result = {
			r: layer.r * layer.a + result.r * (1 - layer.a),
			g: layer.g * layer.a + result.g * (1 - layer.a),
			b: layer.b * layer.a + result.b * (1 - layer.a),
			a: 1,
		};
	}
	return result;
}

function srgbChannelToLinear(channel8bit: number): number {
	const c = channel8bit / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). Ignores alpha — pass an already-composited, opaque color. */
export function relativeLuminance(color: ColorRGBA): number {
	const r = srgbChannelToLinear(color.r);
	const g = srgbChannelToLinear(color.g);
	const b = srgbChannelToLinear(color.b);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, always ≥ 1 regardless of which color is passed first. */
export function contrastRatio(a: ColorRGBA, b: ColorRGBA): number {
	const l1 = relativeLuminance(a);
	const l2 = relativeLuminance(b);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.1 SC 1.4.3 "large-scale text": ≥24px (18pt) normal weight, or ≥~18.67px (14pt) bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
	if (fontSizePx >= 24) return true;
	return fontSizePx >= 18.66 && fontWeight >= 700;
}

export function requiredRatio(large: boolean): number {
	return large ? 3 : 4.5;
}

export interface ContrastMeasurement {
	selector: string;
	/** Bounded text snippet for reporting — not the full element content. */
	textSnippet: string;
	/** getComputedStyle(el).color, raw. */
	foregroundCss: string;
	/**
	 * Raw backgroundColor per element in the ancestor chain, innermost
	 * (the element itself) first, outermost (<html>) last — the shape
	 * measureContrastElements() returns; checkContrastMeasurements()
	 * reverses it before compositing.
	 */
	backgroundChainCss: string[];
	fontSizePx: number;
	fontWeight: number;
}

export interface ContrastViolation {
	selector: string;
	textSnippet: string;
	ratio: number;
	required: number;
	isLargeText: boolean;
}

export interface ContrastCheckResult {
	passed: boolean;
	violations: ContrastViolation[];
}

const TEXT_SNIPPET_MAX_LENGTH = 80;

/** Pure — no browser. Parses/composites/computes ratio for already-extracted measurements (real or fixture data). */
export function checkContrastMeasurements(measurements: ContrastMeasurement[]): ContrastCheckResult {
	const violations: ContrastViolation[] = [];
	for (const m of measurements) {
		const fg = parseCssColor(m.foregroundCss);
		if (!fg) continue; // unparseable color is a data problem, not a contrast violation — skip rather than guess
		// backgroundChainCss is innermost-first; compositeOver expects bottom(outermost)-to-top(innermost).
		const layers = [...m.backgroundChainCss].reverse().map(parseCssColor).filter((c): c is ColorRGBA => c !== undefined);
		const background = compositeOver(layers);
		const ratio = contrastRatio(fg, background);
		const large = isLargeText(m.fontSizePx, m.fontWeight);
		const required = requiredRatio(large);
		if (ratio < required) {
			violations.push({ selector: m.selector, textSnippet: m.textSnippet, ratio, required, isLargeText: large });
		}
	}
	return { passed: violations.length === 0, violations };
}

interface RawContrastMeasurement {
	selector: string;
	found: boolean;
	textSnippet?: string;
	foregroundCss?: string;
	backgroundChainCss?: string[];
	fontSizePx?: number;
	fontWeight?: number;
}

function buildContrastScript(selectors: string[]): string {
	return `(() => {
		const selectors = ${JSON.stringify(selectors)};
		const maxSnippet = ${TEXT_SNIPPET_MAX_LENGTH};
		return selectors.map((selector) => {
			const el = document.querySelector(selector);
			if (!el) return { selector, found: false };
			const style = getComputedStyle(el);
			const backgroundChainCss = [];
			let node = el;
			while (node) {
				backgroundChainCss.push(getComputedStyle(node).backgroundColor);
				node = node.parentElement;
			}
			const text = (el.textContent || "").trim().replace(/\\s+/g, " ");
			return {
				selector,
				found: true,
				textSnippet: text.slice(0, maxSnippet),
				foregroundCss: style.color,
				backgroundChainCss,
				fontSizePx: parseFloat(style.fontSize) || 0,
				fontWeight: parseInt(style.fontWeight, 10) || 400,
			};
		});
	})()`;
}

export class SelectorNotFoundError extends Error {}

/** Extracts real rendered color/font data for a set of selectors. Throws SelectorNotFoundError listing every selector that matched nothing. */
export async function measureContrastElements(page: SessionPage, selectors: string[]): Promise<ContrastMeasurement[]> {
	const raw = await page.evaluate<RawContrastMeasurement[]>(buildContrastScript(selectors));
	const missing = raw.filter((m) => !m.found).map((m) => m.selector);
	if (missing.length > 0) throw new SelectorNotFoundError(`selector(s) matched no element: ${missing.join(", ")}`);
	return raw.map((m) => ({
		selector: m.selector,
		textSnippet: m.textSnippet ?? "",
		foregroundCss: m.foregroundCss as string,
		backgroundChainCss: m.backgroundChainCss as string[],
		fontSizePx: m.fontSizePx as number,
		fontWeight: m.fontWeight as number,
	}));
}

/** The full pipeline: measure real elements on the page, then check WCAG contrast. */
export async function checkContrast(page: SessionPage, selectors: string[]): Promise<ContrastCheckResult> {
	const measurements = await measureContrastElements(page, selectors);
	return checkContrastMeasurements(measurements);
}
