/**
 * SQLite-backed CacheStore — replaces @danypops/web-spider's JSON-file
 * DiskCache as the daemon's sole page cache adapter. Implements the same
 * ICache<string, SpideredPage> port DiskCache implements, so `get`/`set`/
 * `has`/`delete`/`values` are drop-in compatible; `list`/`search` are the
 * new bounded query shapes `cache.list`/`cache.search` need.
 *
 * Large-image spill-to-file behavior is preserved from DiskCache: images
 * whose base64 length exceeds `inlineImageThreshold` are written to
 * `<imagesDir>/<sha1(src)><ext>` and only `filePath` is persisted in SQLite;
 * `get()`/`values()` hydrate them back to base64 on read.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { searchPages, type ImageRef, type SpideredPage } from "@danypops/web-spider";
import {
	CACHE_DEFAULT_INLINE_IMAGE_THRESHOLD,
	CACHE_DEFAULT_MAX_ENTRIES,
	CACHE_DEFAULT_TTL_MS,
	CACHE_LIST_DEFAULT_LIMIT,
	CACHE_LIST_MAX_LIMIT,
	CACHE_SEARCH_DEFAULT_LIMIT,
	CACHE_SEARCH_SNIPPET_RADIUS,
} from "../constants.ts";
import type { CachedPageListFilter, CachedPageListResult, CachedPageSearchResult, CachedPageSummary } from "../domain/page.ts";
import type { CacheStore } from "../ports/cache-store.ts";

export interface SQLiteCacheStoreOptions {
	/** Time-to-live in ms applied on every set(). Default 30 min. */
	ttlMs?: number;
	/** Max page rows. Oldest-by-fetchedAt evicted first once exceeded. Default 500. */
	maxSize?: number;
	/** Directory large images spill to. Default: a sibling of the SQLite file. */
	imagesDir: string;
	/** Base64 length threshold for inline vs. file storage. Default 32 KB. */
	inlineImageThreshold?: number;
}

interface PageRow {
	id: number;
	url: string;
	canonical_url: string | null;
	domain: string;
	title: string;
	description: string;
	author: string;
	published_at: string;
	lang: string;
	tags: string;
	word_count: number;
	reading_time_minutes: number;
	headings: string;
	links: string;
	markdown: string;
	js_rendered: number;
	fetched_at: number;
	expires_at: number;
}

interface PageSummaryRow {
	url: string;
	domain: string;
	title: string;
	description: string;
	word_count: number;
	fetched_at: number;
	expires_at: number;
}

interface ChunkRow {
	id: string;
	idx: number;
	heading: string;
	text: string;
	word_count: number;
	content_type: string;
}

interface ImageRow {
	src: string;
	mime_type: string;
	alt: string;
	base64: string | null;
	file_path: string | null;
}

/** Normalizes a URL to a stable cache key — strips the hash and trailing slash (same rule DiskCache uses). */
export function pageKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

export class SQLiteCacheStore implements CacheStore {
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly imagesDir: string;
	private readonly inlineImageThreshold: number;

	constructor(private readonly db: Database, options: SQLiteCacheStoreOptions) {
		this.ttlMs = options.ttlMs ?? CACHE_DEFAULT_TTL_MS;
		this.maxSize = options.maxSize ?? CACHE_DEFAULT_MAX_ENTRIES;
		this.imagesDir = options.imagesDir;
		this.inlineImageThreshold = options.inlineImageThreshold ?? CACHE_DEFAULT_INLINE_IMAGE_THRESHOLD;
	}

	// ── ICache<string, SpideredPage> ──────────────────────────────────────────

	get(url: string): SpideredPage | undefined {
		const row = this.db.query("SELECT * FROM pages WHERE url_key = ? AND expires_at > ?").get(pageKey(url), Date.now()) as PageRow | null;
		if (!row) return undefined;
		return this.hydratePage(row);
	}

	has(url: string): boolean {
		return this.get(url) !== undefined;
	}

	set(url: string, page: SpideredPage): void {
		const key = pageKey(url);
		const now = Date.now();
		const expiresAt = now + this.ttlMs;
		const tx = this.db.transaction(() => {
			const row = this.db.query(`
				INSERT INTO pages (
					url_key, url, canonical_url, domain, title, description, author, published_at, lang,
					tags, word_count, reading_time_minutes, headings, links, markdown, js_rendered, fetched_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(url_key) DO UPDATE SET
					url = excluded.url, canonical_url = excluded.canonical_url, domain = excluded.domain,
					title = excluded.title, description = excluded.description, author = excluded.author,
					published_at = excluded.published_at, lang = excluded.lang, tags = excluded.tags,
					word_count = excluded.word_count, reading_time_minutes = excluded.reading_time_minutes,
					headings = excluded.headings, links = excluded.links, markdown = excluded.markdown,
					js_rendered = excluded.js_rendered, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
				RETURNING id
			`).get(
				key, page.url, page.canonicalUrl ?? null, page.domain, page.title, page.description, page.author,
				page.publishedAt, page.lang, JSON.stringify(page.tags), page.wordCount, page.readingTimeMinutes,
				JSON.stringify(page.headings), JSON.stringify(page.links), page.markdown, page.jsRendered ? 1 : 0,
				now, expiresAt,
			) as { id: number };

			this.db.query("DELETE FROM chunks WHERE page_id = ?").run(row.id);
			for (const chunk of page.chunks) {
				this.db.query(`
					INSERT INTO chunks (id, page_id, idx, heading, text, word_count, content_type)
					VALUES (?, ?, ?, ?, ?, ?, ?)
				`).run(chunk.id, row.id, chunk.index, chunk.heading, chunk.text, chunk.wordCount, chunk.contentType);
			}

			const oldImagePaths = (this.db.query("SELECT file_path FROM images WHERE page_id = ? AND file_path IS NOT NULL").all(row.id) as Array<{ file_path: string }>).map((r) => r.file_path);
			this.db.query("DELETE FROM images WHERE page_id = ?").run(row.id);
			for (const path of oldImagePaths) { try { rmSync(path, { force: true }); } catch { /* best-effort */ } }
			for (const image of this.spill(page.images ?? [])) {
				this.db.query(`
					INSERT INTO images (page_id, src, mime_type, alt, base64, file_path)
					VALUES (?, ?, ?, ?, ?, ?)
				`).run(row.id, image.src, image.mimeType, image.alt, image.base64 ?? null, image.filePath ?? null);
			}

			this.evict();
		});
		tx.immediate();
	}

	delete(url: string): void {
		const key = pageKey(url);
		const row = this.db.query("SELECT id FROM pages WHERE url_key = ?").get(key) as { id: number } | null;
		if (!row) return;
		const paths = (this.db.query("SELECT file_path FROM images WHERE page_id = ? AND file_path IS NOT NULL").all(row.id) as Array<{ file_path: string }>).map((r) => r.file_path);
		this.db.query("DELETE FROM pages WHERE id = ?").run(row.id);
		for (const path of paths) { try { rmSync(path, { force: true }); } catch { /* best-effort */ } }
	}

	values(): SpideredPage[] {
		const rows = this.db.query("SELECT * FROM pages WHERE expires_at > ? ORDER BY fetched_at DESC LIMIT ?").all(Date.now(), this.maxSize) as PageRow[];
		return rows.map((row) => this.hydratePage(row));
	}

	// ── Bounded query operations ──────────────────────────────────────────────

	list(filter: CachedPageListFilter = {}): CachedPageListResult {
		const now = Date.now();
		const total = (this.db.query("SELECT COUNT(*) AS n FROM pages WHERE expires_at > ?").get(now) as { n: number }).n;

		const conditions = ["expires_at > ?"];
		const parameters: Array<string | number> = [now];
		if (filter.grep?.trim()) {
			const pattern = `%${filter.grep.trim().toLowerCase()}%`;
			conditions.push("(LOWER(url) LIKE ? OR LOWER(title) LIKE ? OR LOWER(domain) LIKE ? OR LOWER(description) LIKE ?)");
			parameters.push(pattern, pattern, pattern, pattern);
		}
		const where = `WHERE ${conditions.join(" AND ")}`;
		const filtered = (this.db.query(`SELECT COUNT(*) AS n FROM pages ${where}`).get(...parameters) as { n: number }).n;

		const offset = Math.max(0, Math.floor(filter.offset ?? 0));
		const limit = Math.max(1, Math.min(CACHE_LIST_MAX_LIMIT, Math.floor(filter.limit ?? CACHE_LIST_DEFAULT_LIMIT)));
		const rows = this.db.query(`
			SELECT url, domain, title, description, word_count, fetched_at, expires_at
			FROM pages
			${where}
			ORDER BY fetched_at DESC
			LIMIT ? OFFSET ?
		`).all(...parameters, limit, offset) as PageSummaryRow[];

		return { total, filtered, offset, limit, pages: rows.map(fromSummaryRow) };
	}

	search(query: string, opts: { topN?: number; snippetRadius?: number } = {}): CachedPageSearchResult {
		const pages = this.values();
		if (!query.trim() || pages.length === 0) {
			return { query, pagesSearched: pages.length, hits: [] };
		}
		const hits = searchPages(pages, query, { topN: opts.topN ?? CACHE_SEARCH_DEFAULT_LIMIT, snippetRadius: opts.snippetRadius ?? CACHE_SEARCH_SNIPPET_RADIUS });
		return {
			query,
			pagesSearched: pages.length,
			hits: hits.map((hit) => {
				const page = pages.find((p) => p.url === hit.url);
				const text = hit.chunkId ? (page?.chunks.find((c) => c.id === hit.chunkId)?.text ?? hit.snippet) : hit.snippet;
				return { url: hit.url, title: page?.title ?? "", score: hit.score, heading: hit.heading, text };
			}),
		};
	}

	pruneExpired(now: number): number {
		// Pre-count rather than trust the DELETE's reported `changes`: bun:sqlite's
		// changes count includes rows removed by an ON DELETE CASCADE (chunks/images
		// for each evicted page), which would overcount "pages removed" here.
		const { n } = this.db.query("SELECT COUNT(*) AS n FROM pages WHERE expires_at <= ?").get(now) as { n: number };
		this.db.query("DELETE FROM pages WHERE expires_at <= ?").run(now);
		return n;
	}

	close(): void {
		this.db.close();
	}

	// ── Eviction ───────────────────────────────────────────────────────────────

	private evict(): void {
		this.db.query("DELETE FROM pages WHERE id NOT IN (SELECT id FROM pages ORDER BY fetched_at DESC LIMIT ?)").run(this.maxSize);
	}

	// ── Image spill / hydrate (ported from DiskCache) ──────────────────────────

	private imageFilename(src: string): string {
		const hash = createHash("sha1").update(src).digest("hex");
		const ext = extname(src.split("?")[0] ?? "") || ".bin";
		return `${hash}${ext}`;
	}

	private spill(images: ImageRef[]): ImageRef[] {
		if (images.length === 0) return images;
		if (!existsSync(this.imagesDir)) mkdirSync(this.imagesDir, { recursive: true });
		return images.map((image) => {
			if (!image.base64 || image.base64.length <= this.inlineImageThreshold) return image;
			const filePath = join(this.imagesDir, this.imageFilename(image.src));
			writeFileSync(filePath, Buffer.from(image.base64, "base64"));
			const { base64: _omit, ...rest } = image;
			return { ...rest, filePath };
		});
	}

	private hydrateImages(rows: ImageRow[]): ImageRef[] {
		return rows.map((row) => {
			if (row.base64) return { src: row.src, mimeType: row.mime_type, alt: row.alt, base64: row.base64 };
			if (row.file_path && existsSync(row.file_path)) {
				try {
					return { src: row.src, mimeType: row.mime_type, alt: row.alt, base64: readFileSync(row.file_path).toString("base64"), filePath: row.file_path };
				} catch {
					return { src: row.src, mimeType: row.mime_type, alt: row.alt, filePath: row.file_path };
				}
			}
			return { src: row.src, mimeType: row.mime_type, alt: row.alt, ...(row.file_path ? { filePath: row.file_path } : {}) };
		});
	}

	private hydratePage(row: PageRow): SpideredPage {
		const chunkRows = this.db.query("SELECT id, idx, heading, text, word_count, content_type FROM chunks WHERE page_id = ? ORDER BY idx").all(row.id) as ChunkRow[];
		const imageRows = this.db.query("SELECT src, mime_type, alt, base64, file_path FROM images WHERE page_id = ?").all(row.id) as ImageRow[];
		return {
			url: row.url,
			domain: row.domain,
			fetchedAt: new Date(row.fetched_at).toISOString(),
			...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
			title: row.title,
			description: row.description,
			author: row.author,
			publishedAt: row.published_at,
			lang: row.lang,
			tags: JSON.parse(row.tags) as string[],
			wordCount: row.word_count,
			readingTimeMinutes: row.reading_time_minutes,
			headings: JSON.parse(row.headings) as SpideredPage["headings"],
			chunks: chunkRows.map((c) => ({ id: c.id, index: c.idx, heading: c.heading, text: c.text, wordCount: c.word_count, contentType: c.content_type as SpideredPage["chunks"][number]["contentType"] })),
			links: JSON.parse(row.links) as SpideredPage["links"],
			...(imageRows.length > 0 ? { images: this.hydrateImages(imageRows) } : {}),
			markdown: row.markdown,
			...(row.js_rendered ? { jsRendered: true } : {}),
		};
	}
}

function fromSummaryRow(row: PageSummaryRow): CachedPageSummary {
	return {
		url: row.url,
		domain: row.domain,
		title: row.title,
		description: row.description,
		wordCount: row.word_count,
		fetchedAt: row.fetched_at,
		expiresAt: row.expires_at,
	};
}
