/**
 * Builds a crawl `urlFilter` predicate from `excludeDomains`/`includeDomains`
 * daemon input -- the daemon-layer plumbing for a capability
 * packages/web-spider's own crawl() already exposes as a raw
 * `urlFilter?: (url: string) => boolean` option (src/crawl/crawl.ts) but that
 * no caller above the core library could reach: only the blunt
 * `sameDomain: boolean` toggle was ever wired through.
 *
 * A "domain" here matches the exact hostname or any of its subdomains
 * (`"example.com"` matches `example.com` and `www.example.com`, not
 * `notexample.com`) -- the same convention Tavily's `excludeDomains` and
 * most crawler configs use. Matching is case-insensitive; a leading
 * `"www."` on an input domain is not special-cased, since a caller who
 * writes `"www.example.com"` presumably means exactly that host and its
 * own subdomains, not the bare apex too.
 */
export function matchesDomain(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase();
	const target = domain.toLowerCase().trim();
	return host === target || host.endsWith(`.${target}`);
}

/**
 * Returns undefined when both lists are empty/absent, so a crawl that
 * doesn't use this feature gets no urlFilter at all -- no behavior change,
 * no extra per-URL closure call. When includeDomains is non-empty, a URL
 * must match one of them; when excludeDomains is non-empty, a URL must not
 * match any of them. Both may be given together (include narrows, exclude
 * then further narrows). A URL that fails to parse is excluded (fails
 * closed) -- crawl()'s own shouldVisit() already validates the URL before
 * calling urlFilter, so this is a defensive fallback, not the common path.
 */
export function buildDomainFilter(excludeDomains?: string[], includeDomains?: string[]): ((url: string) => boolean) | undefined {
	const exclude = excludeDomains?.filter((d) => d.trim().length > 0) ?? [];
	const include = includeDomains?.filter((d) => d.trim().length > 0) ?? [];
	if (exclude.length === 0 && include.length === 0) return undefined;

	return (url: string): boolean => {
		let hostname: string;
		try {
			hostname = new URL(url).hostname;
		} catch {
			return false;
		}
		if (include.length > 0 && !include.some((d) => matchesDomain(hostname, d))) return false;
		if (exclude.length > 0 && exclude.some((d) => matchesDomain(hostname, d))) return false;
		return true;
	};
}
