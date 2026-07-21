/**
 * Explicit opt-in ingestion into Papyrus — never automatic (design doc §6:
 * automatic ingestion of every fetch would silently grow Papyrus's graph
 * unbounded from ordinary browsing/research the user never asked to persist).
 * This service is only ever invoked by the "papyrus.ingest" operation, which
 * a caller (CLI, tool) must explicitly request.
 */
import type { WebSearchResult } from "@danypops/web-spider";
import { PAPYRUS_INGEST_MAX_BATCH } from "./constants.ts";
import { pageToPapyrusDoc, searchResultToPapyrusDoc } from "./papyrus-mapping.ts";
import type { PapyrusIngestPort } from "./ports/papyrus-ingest.ts";
import type { CacheStore } from "./ports/cache-store.ts";

export interface IngestPagesInput {
	kind: "pages";
	urls: string[];
	/** Optional existing Papyrus artifact id to link each created Doc to via "references". */
	relatesTo?: string;
}

export interface IngestSearchResultsInput {
	kind: "search";
	query: string;
	engine?: string;
	results: WebSearchResult[];
	relatesTo?: string;
}

export type PapyrusIngestInput = IngestPagesInput | IngestSearchResultsInput;

export interface PapyrusIngestOutcome {
	url: string;
	docId: string;
}

export interface PapyrusIngestSkipped {
	url: string;
	reason: string;
}

export interface PapyrusIngestOutput {
	ingested: PapyrusIngestOutcome[];
	skipped: PapyrusIngestSkipped[];
}

export class PapyrusIngestService {
	constructor(
		private readonly cache: CacheStore,
		private readonly papyrus: PapyrusIngestPort,
	) {}

	async ingest(input: PapyrusIngestInput): Promise<PapyrusIngestOutput> {
		if (input.kind === "pages") return this.ingestPages(input);
		return this.ingestSearchResults(input);
	}

	private async ingestPages(input: IngestPagesInput): Promise<PapyrusIngestOutput> {
		const urls = input.urls.slice(0, PAPYRUS_INGEST_MAX_BATCH);
		const ingested: PapyrusIngestOutcome[] = [];
		const skipped: PapyrusIngestSkipped[] = [];

		for (const url of urls) {
			const page = this.cache.get(url);
			if (!page) {
				skipped.push({ url, reason: "not cached — fetch it first, then ingest" });
				continue;
			}
			const doc = await this.papyrus.createDoc(pageToPapyrusDoc(page));
			if (input.relatesTo) await this.papyrus.linkDoc(doc.id, "references", input.relatesTo);
			ingested.push({ url, docId: doc.id });
		}

		return { ingested, skipped };
	}

	private async ingestSearchResults(input: IngestSearchResultsInput): Promise<PapyrusIngestOutput> {
		const results = input.results.slice(0, PAPYRUS_INGEST_MAX_BATCH);
		const ingested: PapyrusIngestOutcome[] = [];

		for (const result of results) {
			const doc = await this.papyrus.createDoc(searchResultToPapyrusDoc(result, { query: input.query, engine: input.engine }));
			if (input.relatesTo) await this.papyrus.linkDoc(doc.id, "references", input.relatesTo);
			ingested.push({ url: result.url, docId: doc.id });
		}

		return { ingested, skipped: [] };
	}
}
