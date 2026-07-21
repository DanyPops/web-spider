/**
 * Layout/alignment assertions — the second half of the UI-audit toolkit
 * (see decision-extend-web-spider-daemon-with-tmux-style-browser-se-ua4l).
 * Catches exactly the bug that triggered this work: inconsistent padding
 * between agent-deck's message bubbles and its tool-call card.
 *
 * Given a session's page and a set of CSS selectors expected to share a
 * layout property (e.g. "all these cards should have the same left
 * padding"), measures each element's real rendered geometry/computed
 * style via the browser's own DOM APIs (getBoundingClientRect() +
 * getComputedStyle(), i.e. genuine CDP-backed geometry data, not an
 * approximation) and asserts consistency within a tolerance — reporting
 * the actual disagreeing pixel values, not just pass/fail.
 */
import type { SessionPage } from "./ports/session-registry.ts";

export type LayoutProperty = "top" | "left" | "width" | "height" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft";

export interface ElementBox {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface ElementPadding {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface ElementMeasurement {
	selector: string;
	box: ElementBox;
	padding: ElementPadding;
}

export class SelectorNotFoundError extends Error {}

const PROPERTY_ACCESSORS: Record<LayoutProperty, (m: ElementMeasurement) => number> = {
	top: (m) => m.box.top,
	left: (m) => m.box.left,
	width: (m) => m.box.width,
	height: (m) => m.box.height,
	paddingTop: (m) => m.padding.top,
	paddingRight: (m) => m.padding.right,
	paddingBottom: (m) => m.padding.bottom,
	paddingLeft: (m) => m.padding.left,
};

export interface LayoutMismatch {
	property: LayoutProperty;
	/** Actual value per selector, in the order measurements were supplied. */
	values: Array<{ selector: string; value: number }>;
	/** max(values) - min(values), in pixels. */
	deltaPx: number;
}

export interface LayoutCheckResult {
	consistent: boolean;
	mismatches: LayoutMismatch[];
}

/**
 * Pure — no browser here. Given measurements already extracted (real or
 * fixture data), checks each requested property is consistent across every
 * measurement within toleranceP, reporting the actual disagreeing values
 * for any property that isn't.
 */
export function checkLayoutConsistency(
	measurements: ElementMeasurement[],
	properties: LayoutProperty[],
	tolerancePx = 1,
): LayoutCheckResult {
	const mismatches: LayoutMismatch[] = [];
	for (const property of properties) {
		const accessor = PROPERTY_ACCESSORS[property];
		const values = measurements.map((m) => ({ selector: m.selector, value: accessor(m) }));
		const numbers = values.map((v) => v.value);
		const deltaPx = Math.max(...numbers) - Math.min(...numbers);
		if (deltaPx > tolerancePx) mismatches.push({ property, values, deltaPx });
	}
	return { consistent: mismatches.length === 0, mismatches };
}

interface RawMeasurement {
	selector: string;
	found: boolean;
	box?: ElementBox;
	padding?: ElementPadding;
}

function buildMeasurementScript(selectors: string[]): string {
	// Selectors are embedded as a JSON literal, never string-concatenated into
	// executable code — no injection surface even though these are trusted,
	// caller-supplied selectors (same discipline as domain/session-audit.ts's
	// treatment of eval scripts: the page's own APIs do the work, not string
	// interpolation of untrusted content into a script body).
	return `(() => {
		const selectors = ${JSON.stringify(selectors)};
		return selectors.map((selector) => {
			const el = document.querySelector(selector);
			if (!el) return { selector, found: false };
			const rect = el.getBoundingClientRect();
			const style = getComputedStyle(el);
			return {
				selector,
				found: true,
				box: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
				padding: {
					top: parseFloat(style.paddingTop) || 0,
					right: parseFloat(style.paddingRight) || 0,
					bottom: parseFloat(style.paddingBottom) || 0,
					left: parseFloat(style.paddingLeft) || 0,
				},
			};
		});
	})()`;
}

/**
 * Measures each selector's real rendered box/padding on the session's
 * current page. Throws SelectorNotFoundError listing every selector that
 * matched nothing — a missing selector almost always means a stale test or
 * a typo, and silently producing a partial/nonsensical comparison would be
 * worse than failing clearly.
 */
export async function measureElements(page: SessionPage, selectors: string[]): Promise<ElementMeasurement[]> {
	const raw = await page.evaluate<RawMeasurement[]>(buildMeasurementScript(selectors));
	const missing = raw.filter((m) => !m.found).map((m) => m.selector);
	if (missing.length > 0) {
		throw new SelectorNotFoundError(`selector(s) matched no element: ${missing.join(", ")}`);
	}
	return raw.map((m) => ({ selector: m.selector, box: m.box as ElementBox, padding: m.padding as ElementPadding }));
}

export interface LayoutCheckInput {
	selectors: string[];
	properties: LayoutProperty[];
	tolerancePx?: number;
}

/** The full pipeline: measure real elements on the page, then check consistency. */
export async function checkLayout(page: SessionPage, input: LayoutCheckInput): Promise<LayoutCheckResult> {
	const measurements = await measureElements(page, input.selectors);
	return checkLayoutConsistency(measurements, input.properties, input.tolerancePx);
}
