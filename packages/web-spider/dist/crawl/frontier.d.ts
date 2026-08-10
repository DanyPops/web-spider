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
export declare class InsertionOrderLinkScorer implements LinkScorer {
    score(): number;
}
/**
 * Orders `candidates` by `scorer`, highest score first, breaking ties by
 * original discovery order (a plain stable sort would already do this on
 * current engines, but the explicit index tie-break keeps behavior
 * deterministic across runtimes).
 */
export declare function orderFrontier(candidates: Array<{
    url: string;
    context: LinkScoreContext;
}>, scorer: LinkScorer): string[];
/**
 * Best-first scorer: boosts URL paths that look like durable content
 * (docs/guide/api/blog/article/reference), penalizes paths that look like
 * app chrome or dead ends (login/signup/cart/checkout/submit/account/
 * settings), and slightly prefers shallower depth as a tie-break. Pure
 * string/URL inspection — no network or DOM work. An unparsable URL scores
 * lowest so `shouldVisit`'s own validation is the real gate, not this scorer.
 */
export declare class HeuristicLinkScorer implements LinkScorer {
    score(url: string, context: LinkScoreContext): number;
}
//# sourceMappingURL=frontier.d.ts.map