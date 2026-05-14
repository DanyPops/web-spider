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
    constructor() {
        this.nodes = new Map();
        /** url → outbound edges */
        this.out = new Map();
        /** url → inbound source urls */
        this.in_ = new Map();
    }
    /** Add or update a node from a spidered page. */
    addPage(page) {
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
            if (!link.href)
                continue;
            this.addEdge(page.url, link.href, link.text, link.isExternal);
        }
    }
    /** Add a directed edge without requiring the target to be spidered yet. */
    addEdge(from, to, text, isExternal) {
        const edge = { from, to, text, isExternal };
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
    node(url) {
        return this.nodes.get(url);
    }
    /** Outbound edges from a node. */
    outbound(url) {
        return this.out.get(url) ?? [];
    }
    /** URLs that link TO this page. */
    inbound(url) {
        return this.in_.get(url) ?? [];
    }
    /** Pages with no inbound links — entry points to the graph. */
    roots() {
        return [...this.nodes.values()].filter((n) => (this.in_.get(n.url) ?? []).length === 0);
    }
    /** Pages with no outbound links to other spidered nodes. */
    sinks() {
        return [...this.nodes.values()].filter((n) => {
            const edges = this.out.get(n.url) ?? [];
            return !edges.some((e) => this.nodes.has(e.to));
        });
    }
    /** BFS shortest path between two page URLs. Returns null if unreachable. */
    findPath(from, to) {
        if (from === to)
            return [from];
        const visited = new Set([from]);
        const queue = [[from]];
        while (queue.length > 0) {
            const path = queue.shift();
            const current = path[path.length - 1];
            for (const edge of this.out.get(current) ?? []) {
                if (edge.to === to)
                    return [...path, to];
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
    reachableFrom(startUrl) {
        const visited = new Set([startUrl]);
        const queue = [startUrl];
        while (queue.length > 0) {
            const url = queue.shift();
            for (const edge of this.out.get(url) ?? []) {
                if (!visited.has(edge.to) && this.nodes.has(edge.to)) {
                    visited.add(edge.to);
                    queue.push(edge.to);
                }
            }
        }
        visited.delete(startUrl);
        return [...visited].map((u) => this.nodes.get(u)).filter(Boolean);
    }
    /** Nodes ranked by inbound link count (highest first). */
    byPageRank() {
        return [...this.nodes.values()]
            .map((n) => ({ node: n, inboundCount: (this.in_.get(n.url) ?? []).length }))
            .sort((a, b) => b.inboundCount - a.inboundCount);
    }
    get nodeCount() {
        return this.nodes.size;
    }
    get edgeCount() {
        let total = 0;
        for (const edges of this.out.values())
            total += edges.length;
        return total;
    }
    /** Plain snapshot — safe to JSON.stringify or embed. */
    toJSON() {
        const edges = [];
        for (const edgeList of this.out.values())
            edges.push(...edgeList);
        return { nodes: [...this.nodes.values()], edges };
    }
    static fromJSON(snap) {
        const g = new PageGraph();
        for (const n of snap.nodes)
            g.nodes.set(n.url, n);
        for (const e of snap.edges)
            g.addEdge(e.from, e.to, e.text, e.isExternal);
        return g;
    }
}
//# sourceMappingURL=graph.js.map