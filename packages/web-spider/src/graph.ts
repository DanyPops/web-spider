import type { SpideredPage } from "./types.js";

/** A node in the knowledge graph — lightweight reference, not the full page. */
export interface PageNode {
	url: string;
	domain: string;
	title: string;
	description: string;
	wordCount: number;
	fetchedAt: string;
	chunkCount: number;
}

/** A directed edge between two pages. */
export interface PageEdge {
	from: string;
	to: string;
	/** Anchor text of the link */
	text: string;
	isExternal: boolean;
}

/** Serialisable snapshot for storage or embedding. */
export interface PageGraphSnapshot {
	nodes: PageNode[];
	edges: PageEdge[];
}

/**
 * Directed knowledge graph of spidered pages.
 *
 * Nodes are pages. Edges are outbound links.
 * Maintains a reverse index (inbound links) for O(1) lookup.
 *
 * All graph queries return plain data — no PageNode references —
 * so the graph is trivially serialisable.
 */
export class PageGraph {
	private readonly nodes = new Map<string, PageNode>();
	/** url → outbound edges */
	private readonly out = new Map<string, PageEdge[]>();
	/** url → inbound source urls */
	private readonly in_ = new Map<string, string[]>();

	/** Add or update a node from a spidered page. */
	addPage(page: SpideredPage): void {
		this.nodes.set(page.url, {
			url: page.url,
			domain: page.domain,
			title: page.title,
			description: page.description,
			wordCount: page.wordCount,
			fetchedAt: page.fetchedAt,
			chunkCount: page.chunks.length,
		});

		// Wire edges from the page's outbound links
		for (const link of page.links) {
			if (!link.href) continue;
			this.addEdge(page.url, link.href, link.text, link.isExternal);
		}
	}

	/** Add a directed edge without requiring the target to be spidered yet. */
	addEdge(from: string, to: string, text: string, isExternal: boolean): void {
		const edge: PageEdge = { from, to, text, isExternal };
		const existing = this.out.get(from) ?? [];
		// Deduplicate by (from, to)
		if (!existing.some((e) => e.to === to)) {
			this.out.set(from, [...existing, edge]);
		}
		const inbound = this.in_.get(to) ?? [];
		if (!inbound.includes(from)) {
			this.in_.set(to, [...inbound, from]);
		}
	}

	node(url: string): PageNode | undefined {
		return this.nodes.get(url);
	}

	/** Outbound edges from a node. */
	outbound(url: string): PageEdge[] {
		return this.out.get(url) ?? [];
	}

	/** URLs that link TO this page. */
	inbound(url: string): string[] {
		return this.in_.get(url) ?? [];
	}

	/** Pages with no inbound links — entry points to the graph. */
	roots(): PageNode[] {
		return [...this.nodes.values()].filter((n) => (this.in_.get(n.url) ?? []).length === 0);
	}

	/** Pages with no outbound links to other spidered nodes. */
	sinks(): PageNode[] {
		return [...this.nodes.values()].filter((n) => {
			const edges = this.out.get(n.url) ?? [];
			return !edges.some((e) => this.nodes.has(e.to));
		});
	}

	/** BFS shortest path between two page URLs. Returns null if unreachable. */
	findPath(from: string, to: string): string[] | null {
		if (from === to) return [from];
		const visited = new Set<string>([from]);
		const queue: Array<string[]> = [[from]];

		while (queue.length > 0) {
			const path = queue.shift()!;
			const current = path[path.length - 1];
			for (const edge of this.out.get(current) ?? []) {
				if (edge.to === to) return [...path, to];
				if (!visited.has(edge.to) && this.nodes.has(edge.to)) {
					visited.add(edge.to);
					queue.push([...path, edge.to]);
				}
			}
		}
		return null;
	}

	/**
	 * All pages reachable from `startUrl` via spidered links.
	 * BFS, bounded by the nodes present in the graph.
	 */
	reachableFrom(startUrl: string): PageNode[] {
		const visited = new Set<string>([startUrl]);
		const queue = [startUrl];
		while (queue.length > 0) {
			const url = queue.shift()!;
			for (const edge of this.out.get(url) ?? []) {
				if (!visited.has(edge.to) && this.nodes.has(edge.to)) {
					visited.add(edge.to);
					queue.push(edge.to);
				}
			}
		}
		visited.delete(startUrl);
		return [...visited].map((u) => this.nodes.get(u)!).filter(Boolean);
	}

	/** Nodes ranked by inbound link count (highest first). */
	byPageRank(): Array<{ node: PageNode; inboundCount: number }> {
		return [...this.nodes.values()]
			.map((n) => ({ node: n, inboundCount: (this.in_.get(n.url) ?? []).length }))
			.sort((a, b) => b.inboundCount - a.inboundCount);
	}

	get nodeCount(): number {
		return this.nodes.size;
	}

	get edgeCount(): number {
		let total = 0;
		for (const edges of this.out.values()) total += edges.length;
		return total;
	}

	/** Plain snapshot — safe to JSON.stringify or embed. */
	toJSON(): PageGraphSnapshot {
		const edges: PageEdge[] = [];
		for (const edgeList of this.out.values()) edges.push(...edgeList);
		return { nodes: [...this.nodes.values()], edges };
	}

	static fromJSON(snap: PageGraphSnapshot): PageGraph {
		const g = new PageGraph();
		for (const n of snap.nodes) g.nodes.set(n.url, n);
		for (const e of snap.edges) g.addEdge(e.from, e.to, e.text, e.isExternal);
		return g;
	}
}
