import type { Link } from "../types.js";

/** Context available when scoring one discovered candidate URL. */
export interface LinkScoreContext {
	/** BFS depth this candidate was discovered at. */
	depth: number;
	/** URL of the page the candidate was discovered on. */
	sourceUrl: string;
	/** Link metadata when the candidate came from an in-page anchor; absent for sitemap-discovered URLs. */
	link?: Link;
}

/**
 * Strategy for ordering discovered candidate URLs within one frontier level.
 * Higher scores are visited first. `crawl()` performs no network, cache, or
 * robots I/O here — a scorer only inspects the URL and the context it was
 * discovered in.
 */
export interface LinkScorer {
	score(url: string, context: LinkScoreContext): number;
}

/**
 * Default scorer: every candidate scores equally, so a stable sort leaves
 * today's plain BFS discovery order untouched. This is the seam a future
 * best-first scorer (focus relevance, content-likelihood, depth) replaces
 * without any change to crawl()'s traversal loop.
 */
export class InsertionOrderLinkScorer implements LinkScorer {
	score(): number {
		return 0;
	}
}

/**
 * Orders `candidates` by `scorer`, highest score first, breaking ties by
 * original discovery order (a plain stable sort would already do this on
 * current engines, but the explicit index tie-break keeps behavior
 * deterministic across runtimes).
 */
export function orderFrontier(candidates: Array<{ url: string; context: LinkScoreContext }>, scorer: LinkScorer): string[] {
	return candidates
		.map((candidate, index) => ({ candidate, index, score: scorer.score(candidate.url, candidate.context) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.candidate.url);
}
