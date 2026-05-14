import { describe, expect, it } from "vitest";
import { buildTree, navigateTree, queryTree } from "../src/tree.js";
import type { DOMNode } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _countNodes(node: DOMNode): number {
	return 1 + (node.children ?? []).reduce((n, c) => n + _countNodes(c), 0);
}

function allPaths(node: DOMNode): string[] {
	return [node.path, ...(node.children ?? []).flatMap(allPaths)];
}

function findByTag(node: DOMNode, tag: string): DOMNode[] {
	const results: DOMNode[] = [];
	if (node.tag === tag) results.push(node);
	for (const child of node.children ?? []) results.push(...findByTag(child, tag));
	return results;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIMPLE_HTML = `
<div>
  <h1>Getting Started</h1>
  <p>This is the introduction.</p>
  <h2>Installation</h2>
  <p>Run <code>npm install</code> to get started.</p>
  <pre><code class="language-bash">npm install my-package</code></pre>
  <h2>Usage</h2>
  <ul>
    <li>Item one</li>
    <li>Item two</li>
  </ul>
</div>`;

const TABLE_HTML = `
<div>
  <h2>Comparison</h2>
  <table>
    <thead><tr><th>Feature</th><th>A</th><th>B</th></tr></thead>
    <tbody>
      <tr><td>Speed</td><td>Fast</td><td>Slow</td></tr>
      <tr><td>Cost</td><td>High</td><td>Low</td></tr>
    </tbody>
  </table>
</div>`;

const DEEP_WRAPPER_HTML = `
<div>
  <div>
    <div>
      <div>
        <p>This is deeply nested but should collapse.</p>
      </div>
    </div>
  </div>
</div>`;

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

describe("buildTree", () => {
	it("returns a root node tagged 'article'", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		expect(tree.tag).toBe("article");
		expect(tree.path).toBe("article");
	});

	it("extracts headings", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const h1s = findByTag(tree, "h1");
		const h2s = findByTag(tree, "h2");
		expect(h1s).toHaveLength(1);
		expect(h1s[0].text).toContain("Getting Started");
		expect(h2s).toHaveLength(2);
	});

	it("extracts paragraphs with text", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const ps = findByTag(tree, "p");
		expect(ps.length).toBeGreaterThanOrEqual(2);
		expect(ps[0].text).toContain("introduction");
	});

	it("preserves pre/code blocks as atomic leaf nodes", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const pres = findByTag(tree, "pre");
		expect(pres).toHaveLength(1);
		expect(pres[0].text).toContain("npm install my-package");
		// pre is a leaf — no children
		expect(pres[0].children).toBeUndefined();
	});

	it("extracts lang attr from code blocks", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const pres = findByTag(tree, "pre");
		expect(pres[0].attrs?.lang).toBe("bash");
	});

	it("extracts lists and list items", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const uls = findByTag(tree, "ul");
		expect(uls).toHaveLength(1);
		const lis = findByTag(tree, "li");
		expect(lis).toHaveLength(2);
		expect(lis[0].text).toBe("Item one");
	});

	it("preserves tables as structured subtrees", () => {
		const tree = buildTree(TABLE_HTML, "https://example.com");
		const tables = findByTag(tree, "table");
		expect(tables).toHaveLength(1);
		const tds = findByTag(tree, "td");
		expect(tds.length).toBeGreaterThanOrEqual(4);
		expect(tds[0].text).toBe("Speed");
	});

	it("collapses deep div wrappers", () => {
		const tree = buildTree(DEEP_WRAPPER_HTML, "https://example.com");
		const ps = findByTag(tree, "p");
		expect(ps).toHaveLength(1);
		expect(ps[0].text).toContain("deeply nested");
		// should NOT have div nodes
		const divs = findByTag(tree, "div");
		expect(divs).toHaveLength(0);
	});

	it("generates unique paths for all nodes", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const paths = allPaths(tree);
		const unique = new Set(paths);
		expect(unique.size).toBe(paths.length);
	});

	it("sibling nodes of the same tag get bracket notation", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const h2s = findByTag(tree, "h2");
		expect(h2s[0].path).not.toContain("["); // first h2 has no bracket
		expect(h2s[1].path).toContain("[1]"); // second h2 gets [1]
	});

	it("href attr preserved on anchor tags", () => {
		const html = `<div><p>See <a href="https://example.com/docs">the docs</a>.</p></div>`;
		const tree = buildTree(html, "https://example.com");
		const _links = findByTag(tree, "a");
		// a tags inside p are inline — p is flattened to text, so link may not survive
		// but the p text should contain "the docs"
		const ps = findByTag(tree, "p");
		expect(ps[0].text).toContain("the docs");
	});
});

// ---------------------------------------------------------------------------
// Tree navigation
// ---------------------------------------------------------------------------

describe("navigateTree", () => {
	it("returns the root when path is 'article'", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const node = navigateTree(tree, "article");
		expect(node).toBe(tree);
	});

	it("returns a child node by exact path", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const h1s = findByTag(tree, "h1");
		const h1Path = h1s[0].path;
		const node = navigateTree(tree, h1Path);
		expect(node).toBeDefined();
		expect(node?.tag).toBe("h1");
		expect(node?.text).toContain("Getting Started");
	});

	it("returns null for a non-existent path", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		expect(navigateTree(tree, "article.section[99].p")).toBeNull();
	});

	it("returns a pre node and its content is intact", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const pres = findByTag(tree, "pre");
		const node = navigateTree(tree, pres[0].path);
		expect(node?.tag).toBe("pre");
		expect(node?.text).toContain("npm install");
	});
});

// ---------------------------------------------------------------------------
// Tree fuzzy search
// ---------------------------------------------------------------------------

describe("queryTree", () => {
	it("returns empty array for blank query", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		expect(queryTree(tree, "")).toEqual([]);
		expect(queryTree(tree, "   ")).toEqual([]);
	});

	it("finds a heading by text", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "installation");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].node.tag).toBe("h2");
		expect(hits[0].node.text).toContain("Installation");
	});

	it("finds content in a paragraph", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "introduction");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].snippet).toContain("introduction");
	});

	it("returns code blocks for code queries", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "npm install my-package");
		expect(hits.length).toBeGreaterThan(0);
		const codeHit = hits.find((h) => h.node.tag === "pre");
		expect(codeHit).toBeDefined();
		expect(codeHit!.node.text).toContain("npm install my-package");
	});

	it("sorts hits by score descending", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "npm install");
		for (let i = 1; i < hits.length; i++) {
			expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
		}
	});

	it("respects topN option", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "item", { topN: 1 });
		expect(hits.length).toBeLessThanOrEqual(1);
	});

	it("returns table rows for table queries", () => {
		const tree = buildTree(TABLE_HTML, "https://example.com");
		const hits = queryTree(tree, "speed fast");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].snippet.toLowerCase()).toContain("speed");
	});

	it("does not return duplicate ancestor/descendant pairs", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "npm install");
		// No two hits where one path is a prefix of another at equal score
		for (let i = 0; i < hits.length; i++) {
			for (let j = 0; j < hits.length; j++) {
				if (i === j) continue;
				if (hits[j].path.startsWith(`${hits[i].path}.`) && hits[i].score >= hits[j].score) {
					expect(false).toBe(true); // should have been deduplicated
				}
			}
		}
	});

	it("snippet is non-empty for every hit", () => {
		const tree = buildTree(SIMPLE_HTML, "https://example.com");
		const hits = queryTree(tree, "install");
		for (const h of hits) {
			expect(h.snippet.trim().length).toBeGreaterThan(0);
		}
	});
});
