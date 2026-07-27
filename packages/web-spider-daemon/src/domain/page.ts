export type CachedPageSortField = "fetchedAt" | "publishedAt" | "url" | "domain";
export type CachedPageSortOrder = "asc" | "desc";

export interface CachedPageListFilter {
	/** Case-insensitive substring match against url/title/domain/description. */
	grep?: string;
	/** Exact, case-insensitive match against the domain column. */
	domain?: string;
	/** A page matches if this tag is present anywhere in its tags array (overlap is expected, not filtered out). */
	tag?: string;
	/** A page matches if this curated category (by name) is assigned to it -- overlap is expected, a page in two categories matches both queries. */
	category?: string;
	/** Inclusive bounds on fetched_at (epoch ms) -- cache recency, distinct from the page's own published date. */
	fetchedAfter?: number;
	fetchedBefore?: number;
	/** Inclusive bounds on published_at (ISO-8601 string compare) -- the page's own claimed publish date, not cache recency. */
	publishedAfter?: string;
	publishedBefore?: string;
	/** Defaults to fetchedAt/desc -- must match today's unfiltered listing order exactly. */
	sortBy?: CachedPageSortField;
	sortOrder?: CachedPageSortOrder;
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

/** category.assign / category.remove result -- the category's real id, not just its name, since renaming only ever touches the id's own row. */
export interface CategoryAssignmentResult {
	url: string;
	category: string;
	categoryId: number;
}

/** category.rename result. merged is true when newName already existed as a different category (associations were repointed, the old row dropped) rather than a plain in-place rename. */
export interface CategoryRenameResult {
	categoryId: number;
	name: string;
	merged: boolean;
}

export interface CategorySummary {
	id: number;
	name: string;
	pageCount: number;
}

export interface CategoryListResult {
	categories: CategorySummary[];
}
