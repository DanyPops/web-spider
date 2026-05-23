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
    constructor() {
        this.nodes = Object.create(null);
        /** url → outbound edges */
        this.out = Object.create(null);
        /** url → inbound source urls */
        this.in_ = Object.create(null);
    }
    /** Add or update a node from a spidered page. */
    addPage(page) {
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
            if (!link.href)
                continue;
            this.addEdge(page.url, link.href, link.text, link.isExternal);
        }
    }
    /** Add a directed edge without requiring the target to be spidered yet. */
    addEdge(from, to, text, isExternal) {
        const edge = { from, to, text, isExternal };
        const existing = this.out[from] ?? [];
        if (!existing.some((e) => e.to === to)) {
            this.out[from] = [...existing, edge];
        }
        const inbound = this.in_[to] ?? [];
        if (!inbound.includes(from)) {
            this.in_[to] = [...inbound, from];
        }
    }
    node(url) {
        return this.nodes[url];
    }
    /** Outbound edges from a node. */
    outbound(url) {
        return this.out[url] ?? [];
    }
    /** URLs that link TO this page. */
    inbound(url) {
        return this.in_[url] ?? [];
    }
    /** Pages with no inbound links — entry points to the graph. */
    roots() {
        return Object.values(this.nodes)
            .filter((n) => n !== undefined && (this.in_[n.url] ?? []).length === 0);
    }
    /** Pages with no outbound links to other spidered nodes. */
    sinks() {
        return Object.values(this.nodes)
            .filter((n) => {
            if (!n)
                return false;
            const edges = this.out[n.url] ?? [];
            return !edges.some((e) => e.to in this.nodes);
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
            for (const edge of this.out[current] ?? []) {
                if (edge.to === to)
                    return [...path, to];
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
    reachableFrom(startUrl) {
        const visited = new Set([startUrl]);
        const queue = [startUrl];
        while (queue.length > 0) {
            const url = queue.shift();
            for (const edge of this.out[url] ?? []) {
                if (!visited.has(edge.to) && edge.to in this.nodes) {
                    visited.add(edge.to);
                    queue.push(edge.to);
                }
            }
        }
        visited.delete(startUrl);
        return [...visited].map((u) => this.nodes[u]).filter((n) => n !== undefined);
    }
    /** Nodes ranked by inbound link count (highest first). */
    byPageRank() {
        return Object.values(this.nodes)
            .filter((n) => n !== undefined)
            .map((n) => ({ node: n, inboundCount: (this.in_[n.url] ?? []).length }))
            .sort((a, b) => b.inboundCount - a.inboundCount);
    }
    get nodeCount() {
        return Object.keys(this.nodes).length;
    }
    get edgeCount() {
        let total = 0;
        for (const edges of Object.values(this.out)) {
            if (edges)
                total += edges.length;
        }
        return total;
    }
    /** Plain snapshot — safe to JSON.stringify or embed. */
    toJSON() {
        const edges = [];
        for (const edgeList of Object.values(this.out)) {
            if (edgeList)
                edges.push(...edgeList);
        }
        return {
            nodes: Object.values(this.nodes).filter((n) => n !== undefined),
            edges,
        };
    }
    static fromJSON(snap) {
        const g = new PageGraph();
        for (const n of snap.nodes)
            g.nodes[n.url] = n;
        for (const e of snap.edges)
            g.addEdge(e.from, e.to, e.text, e.isExternal);
        return g;
    }
}
//# sourceMappingURL=graph.js.map