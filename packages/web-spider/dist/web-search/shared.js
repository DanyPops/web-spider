/**
 * Appends a `site:` operator to a raw keyword query for engines with no
 * structured domain-filter parameter (Brave, Serper, SerpApi) -- all three
 * are Google-style keyword search under the hood (Serper/SerpApi literally
 * scrape Google's own SERP), where `site:` is standard, widely-honoured
 * syntax. No-op when siteFilter is unset.
 */
export function withSiteFilter(query, siteFilter) {
    return siteFilter ? `${query} site:${siteFilter}` : query;
}
/** Header names worth capturing when present -- never a blanket capture of every response header. */
export const RATE_LIMIT_HEADER_PATTERN = /rate.?limit|remaining|quota/i;
//# sourceMappingURL=shared.js.map