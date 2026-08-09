import type { SpideredPage } from "../types.js";

/** Coarse shape of a crawled page, used to pick a content-adaptive extraction strategy. */
export type PageType = "article" | "list" | "js_shell" | "unknown";

export interface PageClassification {
	pageType: PageType;
	/** Whether the page's extracted content is usable at all. */
	contentOk: boolean;
}

/**
 * Pure page-classification Strategy, analogous to ContentExtractor:
 * implementations receive an already-fetched SpideredPage and perform no
 * network, cache, robots, throttle, Vehicle, daemon, SQLite, or Pi work.
 */
export interface PageClassifier {
	classify(page: SpideredPage): PageClassification;
}

/**
 * Default classifier: reuses spider()'s existing jsRendered signal to
 * report a JS shell honestly; everything else is reported "unknown"
 * pending the richer article/list heuristic a later task adds. This is
 * the seam that heuristic replaces without any change to crawl()'s loop.
 */
export class DefaultPageClassifier implements PageClassifier {
	classify(page: SpideredPage): PageClassification {
		if (page.jsRendered) {
			return { pageType: "js_shell", contentOk: false };
		}
		return { pageType: "unknown", contentOk: page.contentOk ?? true };
	}
}

const LIST_MIN_LINKS = 15;
const LIST_MAX_WORD_COUNT = 400;
const ARTICLE_MIN_WORD_COUNT = 100;

/**
 * Heuristic classifier: "js_shell" from the existing jsRendered signal;
 * "list" from high link density relative to word count (an index/nav-shaped
 * page); "article" from substantial word count; otherwise "unknown". Never
 * overrides an extractor's own contentOk:false (e.g. a scanned PDF) with a
 * false-confidence classification.
 */
export class HeuristicPageClassifier implements PageClassifier {
	classify(page: SpideredPage): PageClassification {
		if (page.jsRendered) {
			return { pageType: "js_shell", contentOk: false };
		}
		if (page.contentOk === false) {
			return { pageType: "unknown", contentOk: false };
		}
		if (page.links.length >= LIST_MIN_LINKS && page.wordCount < LIST_MAX_WORD_COUNT) {
			return { pageType: "list", contentOk: true };
		}
		if (page.wordCount >= ARTICLE_MIN_WORD_COUNT) {
			return { pageType: "article", contentOk: true };
		}
		return { pageType: "unknown", contentOk: page.wordCount > 0 };
	}
}

/**
 * Renders a "list"-classified page's links as a clean Markdown list, for
 * crawl()'s content-adaptive shaping. Pure text transform — does not
 * re-run extraction; `page.links` (already extracted by spider()) is the
 * only input.
 */
export function renderLinkList(page: SpideredPage): string {
	if (page.links.length === 0) return "";
	const lines = page.links.map((link) => `- [${link.text || link.href}](${link.href})`);
	return `# ${page.title || page.url}\n\n${lines.join("\n")}\n`;
}
