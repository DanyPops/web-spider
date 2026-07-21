/** Domain shape for a cached page summary — the walking skeleton's first real row shape. */
export interface CachedPageSummary {
	url: string;
	domain: string;
	title: string;
	description: string;
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
