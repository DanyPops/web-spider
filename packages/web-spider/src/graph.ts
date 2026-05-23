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
 *
 * Internal storage uses plain objects (Object.create(null)) rather than
 * Maps. Plain objects carry no realm-specific internal slots, making them
 * safe across V8 context (realm) boundaries — e.g. when the graph is
 * constructed in an ESM module realm but called from a jiti VM-sandbox.
 */
export class PageGraph {
	private readonly nodes: Record<string, PageNode | undefined> = Object.create(null);
	/** url → outbound edges */
	private readonly out: Record<string, PageEdge[] | undefined> = Object.create(null);
	/** url → inbound source urls */
	private readonly in_: Record<string, string[] | undefined> = Object.create(null);

	/** Add or update a node from a spidered page. */
	addPage(page: SpideredPage): void {
		this.nodes[page.url] = {
			url: page.url,
			domain: page.domain,
			title: page.title,
			description: page.description,
			wordCount: page.wordCount,
			fetchedAt: page.fetchedAt,
			chunkCount: page.chunks.length,
		};

		for (const link of page.links) {
			if (!link.href) continue;
			this.addEdge(page.url, link.href, link.text, link.isExternal);
		}
	}

	/** Add a directed edge without requiring the target to be spidered yet. */
	addEdge(from: string, to: string, text: string, isExternal: boolean): void {
		const edge: PageEdge = { from, to, text, isExternal };
		const existing = this.out[from] ?? [];
		if (!existing.some((e) => e.to === to)) {
			this.out[from] = [...existing, edge];
		}
		const inbound = this.in_[to] ?? [];
		if (!inbound.includes(from)) {
			this.in_[to] = [...inbound, from];
		}
	}

	node(url: string): PageNode | undefined {
		return this.nodes[url];
	}

	/** Outbound edges from a node. */
	outbound(url: string): PageEdge[] {
		return this.out[url] ?? [];
	}

	/** URLs that link TO this page. */
	inbound(url: string): string[] {
		return this.in_[url] ?? [];
	}

	/** Pages with no inbound links — entry points to the graph. */
	roots(): PageNode[] {
		return Object.values(this.nodes)
			.filter((n): n is PageNode => n !== undefined && (this.in_[n.url] ?? []).length === 0);
	}

	/** Pages with no outbound links to other spidered nodes. */
	sinks(): PageNode[] {
		return Object.values(this.nodes)
			.filter((n): n is PageNode => {
				if (!n) return false;
				const edges = this.out[n.url] ?? [];
				return !edges.some((e) => e.to in this.nodes);
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
			for (const edge of this.out[current] ?? []) {
				if (edge.to === to) return [...path, to];
				if (!visited.has(edge.to) && edge.to in this.nodes) {
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
			for (const edge of this.out[url] ?? []) {
				if (!visited.has(edge.to) && edge.to in this.nodes) {
					visited.add(edge.to);
					queue.push(edge.to);
				}
			}
		}
		visited.delete(startUrl);
		return [...visited].map((u) => this.nodes[u]).filter((n): n is PageNode => n !== undefined);
	}

	/** Nodes ranked by inbound link count (highest first). */
	byPageRank(): Array<{ node: PageNode; inboundCount: number }> {
		return Object.values(this.nodes)
			.filter((n): n is PageNode => n !== undefined)
			.map((n) => ({ node: n, inboundCount: (this.in_[n.url] ?? []).length }))
			.sort((a, b) => b.inboundCount - a.inboundCount);
	}

	get nodeCount(): number {
		return Object.keys(this.nodes).length;
	}

	get edgeCount(): number {
		let total = 0;
		for (const edges of Object.values(this.out)) {
			if (edges) total += edges.length;
		}
		return total;
	}

	/** Plain snapshot — safe to JSON.stringify or embed. */
	toJSON(): PageGraphSnapshot {
		const edges: PageEdge[] = [];
		for (const edgeList of Object.values(this.out)) {
			if (edgeList) edges.push(...edgeList);
		}
		return {
			nodes: Object.values(this.nodes).filter((n): n is PageNode => n !== undefined),
			edges,
		};
	}

	static fromJSON(snap: PageGraphSnapshot): PageGraph {
		const g = new PageGraph();
		for (const n of snap.nodes) g.nodes[n.url] = n;
		for (const e of snap.edges) g.addEdge(e.from, e.to, e.text, e.isExternal);
		return g;
	}
}
