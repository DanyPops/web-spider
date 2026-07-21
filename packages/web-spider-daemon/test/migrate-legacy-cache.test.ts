/**
 * Migration test — writes a real legacy cache file using @danypops/web-spider's
 * own DiskCache (so the fixture always matches the actual on-disk format,
 * not a hand-maintained duplicate of a private schema), then imports it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCache, type SpideredPage } from "@danypops/web-spider";
import { openWebSpiderDb } from "../src/db.ts";
import { SQLiteCacheStore } from "../src/adapters/sqlite-cache-store.ts";
import { importLegacyJsonCache } from "../src/migrate-legacy-cache.ts";

function page(url: string, title: string): SpideredPage {
	return {
		url,
		domain: new URL(url).hostname,
		fetchedAt: new Date().toISOString(),
		title,
		description: "",
		author: "",
		publishedAt: "",
		lang: "en",
		tags: [],
		wordCount: 10,
		readingTimeMinutes: 1,
		headings: [],
		chunks: [],
		links: [],
		markdown: `# ${title}`,
	};
}

describe("importLegacyJsonCache", () => {
	test("imports every non-expired legacy page and renames the source file", () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-migrate-"));
		const legacyPath = join(root, "pages.json");
		try {
			const legacy = new DiskCache(legacyPath, { ttlMs: 60_000 });
			legacy.set("https://a.example/1", page("https://a.example/1", "One"));
			legacy.set("https://a.example/2", page("https://a.example/2", "Two"));

			const db = openWebSpiderDb(":memory:");
			const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
			const store = new SQLiteCacheStore(db, { imagesDir });

			const result = importLegacyJsonCache(store, legacyPath);

			expect(result).toEqual({ imported: 2, skipped: false });
			expect(store.list({}).total).toBe(2);
			expect(store.get("https://a.example/1")?.title).toBe("One");
			expect(existsSync(legacyPath)).toBe(false);
			expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports skipped when there is no legacy file", () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-migrate-"));
		try {
			const db = openWebSpiderDb(":memory:");
			const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
			const store = new SQLiteCacheStore(db, { imagesDir });
			const result = importLegacyJsonCache(store, join(root, "does-not-exist.json"));
			expect(result).toEqual({ imported: 0, skipped: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not rename the source file when the legacy cache had zero non-expired entries", () => {
		const root = mkdtempSync(join(tmpdir(), "web-spider-migrate-"));
		try {
			const legacyPath = join(root, "pages.json");
			const legacy = new DiskCache(legacyPath, { ttlMs: -1 }); // everything expires immediately
			legacy.set("https://a.example/1", page("https://a.example/1", "One"));

			const db = openWebSpiderDb(":memory:");
			const imagesDir = mkdtempSync(join(tmpdir(), "web-spider-images-"));
			const store = new SQLiteCacheStore(db, { imagesDir });
			const result = importLegacyJsonCache(store, legacyPath);

			expect(result).toEqual({ imported: 0, skipped: false });
			expect(existsSync(legacyPath)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
