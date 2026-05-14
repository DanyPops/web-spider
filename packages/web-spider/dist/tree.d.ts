import type { DOMNode, TreeHit } from "./types.js";
/**
 * Build a simplified semantic DOM tree from Readability article HTML.
 *
 * The root is always an "article" node. Presentational wrappers are collapsed,
 * single-child chains are simplified, and only semantic tags survive.
 */
export declare function buildTree(articleHtml: string, baseUrl: string): DOMNode;
/**
 * Navigate to a specific node by its dot-bracket path.
 * Returns null if the path does not exist in the tree.
 *
 * @example navigateTree(tree, "article.section[1].pre[0]")
 */
export declare function navigateTree(root: DOMNode, path: string): DOMNode | null;
export interface QueryTreeOptions {
    /** Max hits to return (default 10). */
    topN?: number;
    /** Context chars around match in snippet (default 100). */
    snippetRadius?: number;
}
/**
 * Fuzzy-search a DOM tree for a query string.
 *
 * Returns hits ranked by score. Each hit is the nearest semantic ancestor
 * that contains the match (a section, li, pre, p — not a raw div). This
 * means code blocks and table rows are always returned whole.
 *
 * @example
 * const hits = queryTree(tree, "declaration merge", { topN: 3 })
 * // hits[0].node is the full <section> containing that heading
 */
export declare function queryTree(root: DOMNode, query: string, opts?: QueryTreeOptions): TreeHit[];
//# sourceMappingURL=tree.d.ts.map