/**
 * Boundary the ingestion application service depends on — Papyrus is a peer
 * daemon, not a library the domain logic should know the shape of. The real
 * adapter (adapters/papyrus-http-adapter.ts) is the only thing that imports
 * @danypops/papyrus; tests inject a fake implementing this port instead.
 */
export interface PapyrusDocInput {
	title: string;
	subtype: string;
	body: string;
	labels: string[];
	extra: Record<string, unknown>;
}

export interface PapyrusIngestPort {
	createDoc(input: PapyrusDocInput): Promise<{ id: string }>;
	linkDoc(fromId: string, relation: string, toId: string): Promise<void>;
}
