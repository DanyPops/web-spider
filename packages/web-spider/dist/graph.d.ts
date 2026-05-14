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
export declare class PageGraph {
    private readonly nodes;
    /** url → outbound edges */
    private readonly out;
    /** url → inbound source urls */
    private readonly in_;
    /** Add or update a node from a spidered page. */
    addPage(page: SpideredPage): void;
    /** Add a directed edge without requiring the target to be spidered yet. */
    addEdge(from: string, to: string, text: string, isExternal: boolean): void;
    node(url: string): PageNode | undefined;
    /** Outbound edges from a node. */
    outbound(url: string): PageEdge[];
    /** URLs that link TO this page. */
    inbound(url: string): string[];
    /** Pages with no inbound links — entry points to the graph. */
    roots(): PageNode[];
    /** Pages with no outbound links to other spidered nodes. */
    sinks(): PageNode[];
    /** BFS shortest path between two page URLs. Returns null if unreachable. */
    findPath(from: string, to: string): string[] | null;
    /**
     * All pages reachable from `startUrl` via spidered links.
     * BFS, bounded by the nodes present in the graph.
     */
    reachableFrom(startUrl: string): PageNode[];
    /** Nodes ranked by inbound link count (highest first). */
    byPageRank(): Array<{
        node: PageNode;
        inboundCount: number;
    }>;
    get nodeCount(): number;
    get edgeCount(): number;
    /** Plain snapshot — safe to JSON.stringify or embed. */
    toJSON(): PageGraphSnapshot;
    static fromJSON(snap: PageGraphSnapshot): PageGraph;
}
//# sourceMappingURL=graph.d.ts.map