/**
 * One-time, best-effort import of the pre-daemon JSON DiskCache into the
 * SQLite-backed CacheStore, per the design doc's migration/compatibility
 * plan. Reuses @danypops/web-spider's own DiskCache class to read the
 * legacy file — this avoids re-implementing its versioned schema guard and
 * image-hydration logic, which are private to disk-cache.ts.
 */
import { existsSync, renameSync } from "node:fs";
import { DiskCache } from "@danypops/web-spider";
import type { CacheStore } from "./ports/cache-store.ts";

export interface LegacyImportResult {
	imported: number;
	/** True when there was no legacy file to import (not an error). */
	skipped: boolean;
}

export function importLegacyJsonCache(store: CacheStore, jsonPath: string): LegacyImportResult {
	if (!existsSync(jsonPath)) return { imported: 0, skipped: true };

	let pages: ReturnType<DiskCache["values"]>;
	try {
		const legacy = new DiskCache(jsonPath, { autoFlush: false });
		pages = legacy.values();
	} catch {
		// Corrupt/unversioned legacy file — DiskCache itself already treats this
		// as "start fresh, do not throw"; the import is best-effort, so we do too.
		return { imported: 0, skipped: false };
	}

	for (const page of pages) store.set(page.url, page);

	if (pages.length > 0) {
		try { renameSync(jsonPath, `${jsonPath}.migrated`); } catch { /* best-effort — leave the original file in place */ }
	}

	return { imported: pages.length, skipped: false };
}
