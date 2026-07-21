/** Lean summary row — used by cache.list. Never carries markdown/chunks/images. */
export interface CachedPageSummary {
	url: string;
	domain: string;
	title: string;
	description: string;
	wordCount: number;
	fetchedAt: number;
	expiresAt: number;
}

export interface CachedPageListFilter {
	/** Case-insensitive substring match against url/title/domain/description. */
	grep?: string;
	offset?: number;
	limit?: number;
}

export interface CachedPageListResult {
	total: number;
	filtered: number;
	offset: number;
	limit: number;
	pages: CachedPageSummary[];
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
