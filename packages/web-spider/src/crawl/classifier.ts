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
