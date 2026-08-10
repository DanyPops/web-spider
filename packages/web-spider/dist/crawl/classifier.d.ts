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
export declare class DefaultPageClassifier implements PageClassifier {
    classify(page: SpideredPage): PageClassification;
}
/**
 * Heuristic classifier: "js_shell" from the existing jsRendered signal;
 * "list" from high link density relative to word count (an index/nav-shaped
 * page); "article" from substantial word count; otherwise "unknown". Never
 * overrides an extractor's own contentOk:false (e.g. a scanned PDF) with a
 * false-confidence classification.
 */
export declare class HeuristicPageClassifier implements PageClassifier {
    classify(page: SpideredPage): PageClassification;
}
/**
 * Renders a "list"-classified page's links as a clean Markdown list, for
 * crawl()'s content-adaptive shaping. Pure text transform — does not
 * re-run extraction; `page.links` (already extracted by spider()) is the
 * only input.
 */
export declare function renderLinkList(page: SpideredPage): string;
//# sourceMappingURL=classifier.d.ts.map