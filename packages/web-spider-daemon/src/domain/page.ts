export interface CachedPageListFilter {
	/** Case-insensitive substring match against url/title/domain/description. */
	grep?: string;
	offset?: number;
	limit?: number;
}

/**
 * cache.list's per-page shape is format.ts's leanOutput() — matching today's
 * pi-extension handleCacheListing() exactly (headings/bodyLinks/tags, not a
 * bare summary), a hard requirement of "preserve the existing web_fetch tool
 * contract exactly" (this is a backend swap, not a tool API change). This is
 * still cheap: headings/links/tags are inline JSON columns on `pages` — no
 * chunks/images child-table join is needed for a listing.
 */
export interface CachedPageListResult {
	total: number;
	filtered: number;
	offset: number;
	limit: number;
	pages: Array<Record<string, unknown>>;
}

/** cache.search result shape — mirrors today's pi-extension highlightHit() output (full chunk text, not a snippet). */
export interface CachedPageSearchHit {
	url: string;
	title: string;
	score: number;
	heading: string;
	text: string;
}

export interface CachedPageSearchResult {
	query: string;
	pagesSearched: number;
	hits: CachedPageSearchHit[];
}
