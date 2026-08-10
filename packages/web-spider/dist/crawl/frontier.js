/**
 * Default scorer: every candidate scores equally, so a stable sort leaves
 * today's plain BFS discovery order untouched. This is the seam a future
 * best-first scorer (focus relevance, content-likelihood, depth) replaces
 * without any change to crawl()'s traversal loop.
 */
export class InsertionOrderLinkScorer {
    score() {
        return 0;
    }
}
/**
 * Orders `candidates` by `scorer`, highest score first, breaking ties by
 * original discovery order (a plain stable sort would already do this on
 * current engines, but the explicit index tie-break keeps behavior
 * deterministic across runtimes).
 */
export function orderFrontier(candidates, scorer) {
    return candidates
        .map((candidate, index) => ({ candidate, index, score: scorer.score(candidate.url, candidate.context) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.candidate.url);
}
const BOOST_PATH_PATTERNS = [/\/docs?\//i, /\/guide/i, /\/api\//i, /\/blog\//i, /\/article/i, /\/reference/i];
const PENALTY_PATH_PATTERNS = [
    /\/login/i,
    /\/signin/i,
    /\/sign-in/i,
    /\/signup/i,
    /\/sign-up/i,
    /\/register/i,
    /\/cart/i,
    /\/checkout/i,
    /\/submit/i,
    /\/logout/i,
    /\/account/i,
    /\/settings/i,
];
const BOOST_SCORE = 5;
const PENALTY_SCORE = 10;
const DEPTH_PENALTY_PER_HOP = 1;
/**
 * Best-first scorer: boosts URL paths that look like durable content
 * (docs/guide/api/blog/article/reference), penalizes paths that look like
 * app chrome or dead ends (login/signup/cart/checkout/submit/account/
 * settings), and slightly prefers shallower depth as a tie-break. Pure
 * string/URL inspection — no network or DOM work. An unparsable URL scores
 * lowest so `shouldVisit`'s own validation is the real gate, not this scorer.
 */
export class HeuristicLinkScorer {
    score(url, context) {
        let path;
        try {
            path = new URL(url).pathname;
        }
        catch {
            return Number.NEGATIVE_INFINITY;
        }
        let score = 0;
        for (const pattern of BOOST_PATH_PATTERNS)
            if (pattern.test(path))
                score += BOOST_SCORE;
        for (const pattern of PENALTY_PATH_PATTERNS)
            if (pattern.test(path))
                score -= PENALTY_SCORE;
        score -= context.depth * DEPTH_PENALTY_PER_HOP;
        return score;
    }
}
//# sourceMappingURL=frontier.js.map