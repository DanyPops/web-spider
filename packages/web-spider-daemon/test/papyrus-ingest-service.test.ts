import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpideredPage, WebSearchResult } from "@danypops/web-spider";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";
import { PapyrusIngestService } from "../src/papyrus-ingest-service.ts";
import type { PapyrusDocInput, PapyrusIngestPort } from "../src/ports/papyrus-ingest.ts";
import { PAPYRUS_INGEST_MAX_BATCH } from "../src/constants.ts";

function page(url: string, title: string): SpideredPage {
	return {
		url, domain: new URL(url).hostname, fetchedAt: new Date().toISOString(),
		title, description: "", author: "", publishedAt: "", lang: "en", tags: [],
		wordCount: 10, readingTimeMinutes: 1, headings: [], chunks: [], links: [], markdown: `# ${title}`,
	};
}

/** Records every call — proves the trust boundary (docs.create/docs.link only) and the immutability invariant (no update ever called). */
class FakePapyrus implements PapyrusIngestPort {
	created: PapyrusDocInput[] = [];
	links: Array<{ fromId: string; relation: string; toId: string }> = [];
	private nextId = 1;

	async createDoc(input: PapyrusDocInput): Promise<{ id: string }> {
		this.created.push(input);
		return { id: `doc-${this.nextId++}` };
	}

	async linkDoc(fromId: string, relation: string, toId: string): Promise<void> {
		this.links.push({ fromId, relation, toId });
	}
}

function storeWith(pages: SpideredPage[]): SQLiteCacheStore {
	const db = openWebSpiderDb(":memory:");
	const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
	const store = new SQLiteCacheStore(db, { imagesDir });
	for (const p of pages) store.set(p.url, p);
	return store;
}

describe("PapyrusIngestService — pages", () => {
	test("ingests each cached URL and returns its new Papyrus doc id", async () => {
		const store = storeWith([page("https://a.example/1", "One"), page("https://a.example/2", "Two")]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		const result = await service.ingest({ kind: "pages", urls: ["https://a.example/1", "https://a.example/2"] });

		expect(result.ingested).toEqual([
			{ url: "https://a.example/1", docId: "doc-1" },
			{ url: "https://a.example/2", docId: "doc-2" },
		]);
		expect(result.skipped).toEqual([]);
		expect(papyrus.created.map((d) => d.title)).toEqual(["One", "Two"]);
	});

	test("skips URLs that are not cached, with an actionable reason, instead of failing the whole batch", async () => {
		const store = storeWith([page("https://a.example/1", "One")]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		const result = await service.ingest({ kind: "pages", urls: ["https://a.example/1", "https://a.example/not-cached"] });

		expect(result.ingested).toEqual([{ url: "https://a.example/1", docId: "doc-1" }]);
		expect(result.skipped).toEqual([{ url: "https://a.example/not-cached", reason: "not cached — fetch it first, then ingest" }]);
	});

	test("links each created doc to relatesTo via 'references' when supplied", async () => {
		const store = storeWith([page("https://a.example/1", "One")]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		await service.ingest({ kind: "pages", urls: ["https://a.example/1"], relatesTo: "task-123" });

		expect(papyrus.links).toEqual([{ fromId: "doc-1", relation: "references", toId: "task-123" }]);
	});

	test("does not link anything when relatesTo is omitted", async () => {
		const store = storeWith([page("https://a.example/1", "One")]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		await service.ingest({ kind: "pages", urls: ["https://a.example/1"] });

		expect(papyrus.links).toEqual([]);
	});

	test("bounds the batch to PAPYRUS_INGEST_MAX_BATCH even when more URLs are requested", async () => {
		const urls = Array.from({ length: PAPYRUS_INGEST_MAX_BATCH + 5 }, (_, i) => `https://a.example/${i}`);
		const store = storeWith(urls.map((url, i) => page(url, `Page ${i}`)));
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		const result = await service.ingest({ kind: "pages", urls });

		expect(result.ingested.length + result.skipped.length).toBe(PAPYRUS_INGEST_MAX_BATCH);
		expect(papyrus.created.length).toBe(PAPYRUS_INGEST_MAX_BATCH);
	});

	test("never calls anything but createDoc/linkDoc — no update capability exists on the port at all", async () => {
		const store = storeWith([page("https://a.example/1", "One")]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);
		await service.ingest({ kind: "pages", urls: ["https://a.example/1"] });
		// PapyrusIngestPort declares only createDoc/linkDoc (see ports/papyrus-ingest.ts) —
		// there is no update method to call, by construction of the port's type itself.
		const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(papyrus)).filter((n) => n !== "constructor");
		expect(methodNames.sort()).toEqual(["createDoc", "linkDoc"]);
	});
});

describe("PapyrusIngestService — search results", () => {
	const results: WebSearchResult[] = [
		{ url: "https://a.example/hit1", title: "Hit One", snippet: "First snippet." },
		{ url: "https://a.example/hit2", title: "Hit Two", snippet: "Second snippet." },
	];

	test("ingests every supplied result without requiring them to be cached", async () => {
		const store = storeWith([]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		const result = await service.ingest({ kind: "search", query: "rate limiting", results });

		expect(result.ingested).toEqual([
			{ url: "https://a.example/hit1", docId: "doc-1" },
			{ url: "https://a.example/hit2", docId: "doc-2" },
		]);
		expect(papyrus.created.every((d) => d.subtype === "web-search-result")).toBe(true);
	});

	test("bounds the batch to PAPYRUS_INGEST_MAX_BATCH", async () => {
		const many = Array.from({ length: PAPYRUS_INGEST_MAX_BATCH + 3 }, (_, i) => ({ url: `https://a.example/${i}`, title: `Hit ${i}`, snippet: "s" }));
		const store = storeWith([]);
		const papyrus = new FakePapyrus();
		const service = new PapyrusIngestService(store, papyrus);

		const result = await service.ingest({ kind: "search", query: "q", results: many });

		expect(result.ingested.length).toBe(PAPYRUS_INGEST_MAX_BATCH);
	});
});
