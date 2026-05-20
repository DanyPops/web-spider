import { JSDOM, VirtualConsole } from "jsdom";
// See parse.ts for rationale — a bare VirtualConsole silently drops all
// jsdomError events so CSS parse failures never reach process.stderr.
const silentConsole = new VirtualConsole();
// ---------------------------------------------------------------------------
// Semantic tag sets
// ---------------------------------------------------------------------------
/**
 * Tags that are kept as-is in the simplified tree.
 * Everything else is either collapsed (single-child wrappers) or stripped.
 */
const BLOCK_TAGS = new Set([
    "article",
    "section",
    "main",
    "aside",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "blockquote",
    "pre",
    "figure",
    "figcaption",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "details",
    "summary",
]);
const INLINE_TAGS = new Set(["a", "code", "strong", "em", "abbr", "time", "mark", "s", "del", "ins"]);
const SEMANTIC_TAGS = new Set([...BLOCK_TAGS, ...INLINE_TAGS]);
/** Tags whose subtrees should be flattened to a single text node. */
const LEAF_CONTAINERS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th", "figcaption", "summary"]);
/** Tags where we want to preserve full child structure. */
const BRANCH_CONTAINERS = new Set([
    "pre",
    "ul",
    "ol",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "section",
    "article",
    "aside",
    "blockquote",
    "details",
    "figure",
]);
// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------
/**
 * Extract the language from a <code> or <pre> element's class attribute.
 * Turndown and most syntax highlighters use class="language-typescript" etc.
 */
function extractLang(el) {
    const cls = el.getAttribute("class") ?? "";
    const m = /language-([a-zA-Z0-9_+-]+)/.exec(cls);
    return m ? m[1] : undefined;
}
/** Flatten all descendant text content into one trimmed string. */
function flattenText(el) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}
/**
 * Recursively build a DOMNode from an Element.
 * Returns null if the element has no meaningful content.
 */
function buildNode(el, pathPrefix, siblingIndex) {
    const tag = el.tagName.toLowerCase();
    // Compute path segment
    const count = siblingIndex.get(tag) ?? 0;
    siblingIndex.set(tag, count + 1);
    const segment = count === 0 ? tag : `${tag}[${count}]`;
    const path = pathPrefix ? `${pathPrefix}.${segment}` : segment;
    // Attrs
    const attrs = {};
    if (tag === "a") {
        const href = el.getAttribute("href");
        if (href && !href.startsWith("javascript:"))
            attrs.href = href;
    }
    if (tag === "code" || tag === "pre") {
        const lang = extractLang(el) ?? extractLang(el.querySelector("code") ?? el);
        if (lang)
            attrs.lang = lang;
    }
    if (tag === "abbr") {
        const title = el.getAttribute("title");
        if (title)
            attrs.title = title;
    }
    if (tag === "time") {
        const dt = el.getAttribute("datetime");
        if (dt)
            attrs.datetime = dt;
    }
    // Leaf containers — flatten to text
    if (LEAF_CONTAINERS.has(tag)) {
        const text = flattenText(el);
        if (!text)
            return null;
        return {
            tag,
            path,
            text,
            ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        };
    }
    // pre — treat the entire block (including nested <code>) as one leaf
    if (tag === "pre") {
        const text = (el.textContent ?? "").trimEnd();
        if (!text.trim())
            return null;
        return {
            tag,
            path,
            text,
            ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        };
    }
    // Branch containers — recurse into children
    const children = [];
    const childIndex = new Map();
    for (const child of Array.from(el.children)) {
        const childTag = child.tagName.toLowerCase();
        if (SEMANTIC_TAGS.has(childTag)) {
            const node = buildNode(child, path, childIndex);
            if (node)
                children.push(node);
        }
        else {
            // Non-semantic wrapper: collapse by recursing with the same path/index
            const collapsed = collapseWrapper(child, path, childIndex);
            children.push(...collapsed);
        }
    }
    if (children.length === 0) {
        // Branch with no semantic children — try as text leaf
        const text = flattenText(el);
        if (!text)
            return null;
        return { tag, path, text, ...(Object.keys(attrs).length > 0 ? { attrs } : {}) };
    }
    // Collapse single-child branches with the same tag family
    if (children.length === 1 && !BRANCH_CONTAINERS.has(tag)) {
        // Promote the child up, but keep the parent path
        return children[0];
    }
    return {
        tag,
        path,
        children,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    };
}
/**
 * Collapse a non-semantic wrapper element, returning its semantic descendants.
 */
function collapseWrapper(el, pathPrefix, siblingIndex) {
    const results = [];
    for (const child of Array.from(el.children)) {
        const childTag = child.tagName.toLowerCase();
        if (SEMANTIC_TAGS.has(childTag)) {
            const node = buildNode(child, pathPrefix, siblingIndex);
            if (node)
                results.push(node);
        }
        else {
            results.push(...collapseWrapper(child, pathPrefix, siblingIndex));
        }
    }
    // If no semantic children found, treat wrapper text as a paragraph
    if (results.length === 0) {
        const text = flattenText(el);
        if (text.length > 20) {
            const count = siblingIndex.get("p") ?? 0;
            siblingIndex.set("p", count + 1);
            const segment = count === 0 ? "p" : `p[${count}]`;
            results.push({ tag: "p", path: `${pathPrefix}.${segment}`, text });
        }
    }
    return results;
}
/**
 * Build a simplified semantic DOM tree from Readability article HTML.
 *
 * The root is always an "article" node. Presentational wrappers are collapsed,
 * single-child chains are simplified, and only semantic tags survive.
 */
export function buildTree(articleHtml, baseUrl) {
    const dom = new JSDOM(articleHtml, { url: baseUrl, virtualConsole: silentConsole });
    const body = dom.window.document.body;
    const children = [];
    const siblingIndex = new Map();
    for (const child of Array.from(body.children)) {
        const childTag = child.tagName.toLowerCase();
        if (SEMANTIC_TAGS.has(childTag)) {
            const node = buildNode(child, "article", siblingIndex);
            if (node)
                children.push(node);
        }
        else {
            const collapsed = collapseWrapper(child, "article", siblingIndex);
            children.push(...collapsed);
        }
    }
    return { tag: "article", path: "article", children };
}
// ---------------------------------------------------------------------------
// Tree navigation
// ---------------------------------------------------------------------------
/** Collect all nodes in the tree as a flat list (depth-first). */
function allNodes(node) {
    const result = [node];
    if (node.children) {
        for (const child of node.children)
            result.push(...allNodes(child));
    }
    return result;
}
/**
 * Navigate to a specific node by its dot-bracket path.
 * Returns null if the path does not exist in the tree.
 *
 * @example navigateTree(tree, "article.section[1].pre[0]")
 */
export function navigateTree(root, path) {
    const nodes = allNodes(root);
    return nodes.find((n) => n.path === path) ?? null;
}
// ---------------------------------------------------------------------------
// Tree fuzzy search
// ---------------------------------------------------------------------------
/** Extract all text content from a node recursively. */
function nodeText(node) {
    if (node.text)
        return node.text;
    if (!node.children)
        return "";
    return node.children.map(nodeText).join(" ");
}
/** Semantic "block" tags that make good hit containers. */
const HIT_CONTAINERS = new Set([
    "section",
    "article",
    "aside",
    "blockquote",
    "details",
    "li",
    "pre",
    "p",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
]);
/**
 * Score text against a query using token overlap + exact phrase bonus.
 * Returns 0–1.
 */
function scoreText(text, queryTokens, fullQuery) {
    if (!text)
        return 0;
    const lower = text.toLowerCase();
    let score = lower.includes(fullQuery) ? 0.6 : 0;
    const perToken = 0.4 / Math.max(queryTokens.length, 1);
    for (const qt of queryTokens) {
        if (lower.includes(qt))
            score += perToken;
    }
    return Math.min(score, 1);
}
/** Build a short snippet around the best match position. */
function buildSnippet(text, fullQuery, queryTokens, radius = 100) {
    const lower = text.toLowerCase();
    let pos = lower.indexOf(fullQuery);
    if (pos === -1) {
        for (const qt of queryTokens) {
            const p = lower.indexOf(qt);
            if (p !== -1) {
                pos = p;
                break;
            }
        }
    }
    if (pos === -1)
        pos = 0;
    const start = Math.max(0, pos - radius);
    const end = Math.min(text.length, pos + Math.max(fullQuery.length, 1) + radius);
    const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
    return (start > 0 ? "…" : "") + raw + (end < text.length ? "…" : "");
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
export function queryTree(root, query, opts = {}) {
    const { topN = 10, snippetRadius = 100 } = opts;
    if (!query.trim())
        return [];
    const fullQuery = query.trim().toLowerCase();
    const queryTokens = fullQuery.split(/\s+/).filter((t) => t.length > 1);
    const nodes = allNodes(root);
    const hits = [];
    for (const node of nodes) {
        // Only return hit containers — not intermediate wrappers, not the root.
        if (!HIT_CONTAINERS.has(node.tag))
            continue;
        if (node.path === "article")
            continue; // root always matches everything — skip it
        const text = nodeText(node);
        const score = scoreText(text, queryTokens, fullQuery);
        if (score === 0)
            continue;
        hits.push({
            path: node.path,
            score,
            node,
            snippet: buildSnippet(text, fullQuery, queryTokens, snippetRadius),
        });
    }
    // Deduplicate: if a parent and child both match, keep only the more specific
    // (higher-scoring) one. If scores are equal, prefer the ancestor (more context).
    const deduped = hits
        .sort((a, b) => b.score - a.score)
        .filter((hit, i, arr) => {
        // Remove this hit if a better-scoring ancestor is already in the list
        return !arr.slice(0, i).some((other) => hit.path.startsWith(`${other.path}.`) && other.score >= hit.score);
    });
    return deduped.slice(0, topN);
}
//# sourceMappingURL=tree.js.map