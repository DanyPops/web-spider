/** Selects how much content spider() returns. */
export type PageView = "lean" | "full" | "tree";

// ---------------------------------------------------------------------------
// DOM tree types
// ---------------------------------------------------------------------------

/**
 * A single node in the simplified DOM tree.
 *
 * The tree is built from the Readability article HTML with all presentational
 * wrapper elements collapsed. Only semantically meaningful tags survive.
 * Single-child chains (div > div > p) are reduced to the leaf (p).
 *
 * Paths use bracket notation for siblings of the same tag:
 *   "article.section[1].pre[0].code"
 *
 * Agents can:
 *   - Read the tree to understand page structure without fetching full markdown.
 *   - Call navigateTree(tree, path) to extract one exact node.
 *   - Call queryTree(tree, query) to fuzzy-search and get matching subtrees.
 */
export interface DOMNode {
	/** HTML tag name, lower-cased. */
	tag: string;
	/** Stable dot-bracket path from the tree root, e.g. "article.section[1].pre[0].code". */
	path: string;
	/**
	 * Text content of this node.
	 * For leaf nodes: the raw text. For branch nodes: concatenated descendant text.
	 * Omitted when the node has children to avoid duplication.
	 */
	text?: string;
	/**
	 * Semantically useful attributes only.
	 * a → href, code → lang (from class="language-*"), abbr → title.
	 */
	attrs?: Record<string, string>;
	/** Child nodes. Present on branch nodes, absent on leaves. */
	children?: DOMNode[];
}

/** A hit returned by queryTree — a matching subtree with score and context. */
export interface TreeHit {
	/** Dot-bracket path of the matching node. */
	path: string;
	/** Score 0–1. Higher is a better match. */
	score: number;
	/** The matching node (may be a branch — e.g. a whole section). */
	node: DOMNode;
	/** Short context around the best match, ≤ 200 chars. */
	snippet: string;
}

/** Dominant content type of a chunk — detected from the markdown buffer. */
export type ChunkType = "text" | "code" | "table" | "list" | "blockquote";

/** One embeddable, self-contained segment of a page. The unit of RAG. */
export interface Chunk {
	/** Stable reference: "<url>#chunk-<index>" */
	id: string;
	index: number;
	/** Nearest ancestor heading, empty string if none */
	heading: string;
	/** Clean Markdown text */
	text: string;
	wordCount: number;
	/** Dominant content type — lets agents skip code/table chunks when summarising. */
	contentType: ChunkType;
}

/** An outbound link — one edge in the knowledge graph. */
export interface Link {
	href: string;
	text: string;
	isExternal: boolean;
	/**
	 * Where in the page the link was found.
	 * "body"  — inside the article content (strongest signal).
	 * "nav"   — inside nav, header, footer, or aside (navigation chrome).
	 */
	rel: "body" | "nav";
}

/**
 * Minimal link for lean views — isExternal omitted (inferable from the URL).
 * Saves tokens when pages carry hundreds of links.
 */
export interface LeanLink {
	href: string;
	text: string;
}

/**
 * Compact page view — identity, metadata, and structural outline only.
 * No chunk text, no markdown body. Use when deciding whether/where to dig
 * deeper. Roughly 5–20× fewer tokens than a full SpideredPage.
 *
 * Headings are flat markdown strings ("## Section") rather than objects —
 * same information, ~half the tokens.
 */
export interface LeanPage {
	readonly view: "lean";

	// --- identity ---
	url: string;
	domain: string;
	/** Canonical URL when it differs from the fetched URL (og:url / link[rel=canonical]). */
	canonicalUrl?: string;

	// --- metadata ---
	title: string;
	description?: string;
	author?: string;
	publishedAt?: string;
	lang: string;
	/** Extracted topic tags — from meta keywords and article:tag. Compact vocabulary for grouping. */
	tags: string[];

	// --- content signals ---
	wordCount: number;
	readingTimeMinutes: number;
	/** How many RAG chunks a full view would produce. */
	chunkCount: number;

	// --- structural outline ---
	/** Heading outline as flat markdown strings, e.g. "## Section Name". */
	headings: string[];

	// --- graph edges ---
	/** Outbound links — href + anchor text only. */
	links: LeanLink[];
}

/**
 * Downgrade a full SpideredPage to a LeanPage.
 * Use when you have already fetched full but only need the outline in context.
 */
export function toLean(page: SpideredPage): LeanPage {
	return {
		view: "lean",
		url: page.url,
		domain: page.domain,
		...(page.canonicalUrl !== undefined ? { canonicalUrl: page.canonicalUrl } : {}),
		title: page.title,
		...(page.description ? { description: page.description } : {}),
		...(page.author ? { author: page.author } : {}),
		...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
		lang: page.lang,
		tags: page.tags,
		wordCount: page.wordCount,
		readingTimeMinutes: page.readingTimeMinutes,
		chunkCount: page.chunks.length,
		headings: page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
		links: page.links
			.filter((l) => l.rel === "body")
			.slice(0, 10)
			.map((l) => ({ href: l.href, text: l.text })),
	};
}

/**
 * A fully spidered page.
 *
 * Follows the Local Materialized View rule: every field is a named,
 * independently readable value — never a serialized blob. Agents read
 * individual fields; RAG embeds individual chunks; graph walkers follow
 * individual links.
 */
export interface SpideredPage {
	// --- identity ---
	url: string;
	domain: string;
	fetchedAt: string; // ISO-8601
	/** Canonical URL when it differs from the fetched URL (og:url / link[rel=canonical]). */
	canonicalUrl?: string;

	// --- metadata (readable at a glance) ---
	title: string;
	description: string;
	author: string;
	publishedAt: string;
	lang: string;
	/** Extracted topic tags — from meta keywords and article:tag. */
	tags: string[];

	// --- content signals ---
	wordCount: number;
	readingTimeMinutes: number;

	// --- structured content ---
	/** Heading outline — h1/h2/h3 only */
	headings: Array<{ level: 1 | 2 | 3; text: string }>;
	/** RAG-ready chunks */
	chunks: Chunk[];

	// --- graph edges ---
	/** Outbound links from this page */
	links: Link[];

	// --- full body (fallback / debug) ---
	markdown: string;
}
