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

/**
 * A single image scraped from a page.
 *
 * Storage contract:
 *   - base64 is populated when the image is small enough to store inline.
 *   - filePath is populated when the image has been spilled to disk.
 *   - At least one of base64 or filePath is present on a hydrated ImageRef.
 *
 * LLM wire format (works with OpenAI, Anthropic, Together, Gemini):
 *   `data:${mimeType};base64,${base64}`
 */
export interface ImageRef {
	/** Original absolute src URL of the image. */
	src: string;
	/** Base64-encoded image bytes. Omitted when the image is stored on disk. */
	base64?: string;
	/** MIME type detected from Content-Type or src extension, e.g. "image/jpeg". */
	mimeType: string;
	/** Alt text from the <img> tag, empty string when absent. */
	alt: string;
	/** Path to the binary file when the image has been persisted to disk. */
	filePath?: string;
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

	/** True when the page appears JS-rendered — metadata may be partial. */
	jsRendered?: boolean;
	/**
	 * Number of other spidered pages that link to this page.
	 * Populated when a PageGraph is passed to toLean(). Omitted otherwise.
	 * Higher = more authoritative within the crawled corpus.
	 */
	inboundCount?: number;
	/**
	 * The response's raw Content-Type header, present only when the fetched
	 * URL was not HTML (e.g. "text/plain", "application/json") — no HTML
	 * extraction was attempted; markdown/headings/links are derived directly
	 * from the raw body instead of a DOM. Omitted for ordinary HTML pages,
	 * preserving the existing contract for the common case.
	 */
	contentType?: string;
	/**
	 * Name of the query strategy that produced this page instead of the
	 * generic fetch+Readability path (e.g. "llms.txt"). `url` reflects the
	 * resource actually fetched (which may differ from the URL originally
	 * requested — a strategy can resolve to a different, more structured
	 * resource at the same origin). Omitted when no strategy applied.
	 */
	viaStrategy?: string;
}

// toLean() moved to views.ts. Import from there or from the package root.

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

	// --- images (opt-in, requires captureImages: true) ---
	/**
	 * Images scraped from the article content.
	 * Only populated when spider() is called with captureImages: true.
	 */
	images?: ImageRef[];

	// --- full body (fallback / debug) ---
	markdown: string;

	/**
	 * True when the page appears to be JavaScript-rendered (Readability
	 * found no content). metadata and links are still populated where
	 * possible; chunks and markdown are empty.
	 */
	jsRendered?: boolean;
	/**
	 * The response's raw Content-Type header, present only when the fetched
	 * URL was not HTML (e.g. "text/plain", "application/json") — no HTML
	 * extraction was attempted; markdown/headings/links are derived directly
	 * from the raw body instead of a DOM. Omitted for ordinary HTML pages,
	 * preserving the existing contract for the common case.
	 */
	contentType?: string;
	/**
	 * Name of the query strategy that produced this page instead of the
	 * generic fetch+Readability path (e.g. "llms.txt"). `url` reflects the
	 * resource actually fetched (which may differ from the URL originally
	 * requested — a strategy can resolve to a different, more structured
	 * resource at the same origin). Omitted when no strategy applied.
	 */
	viaStrategy?: string;
}
