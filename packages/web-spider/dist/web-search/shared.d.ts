/** The set of search engines this package ships an adapter for. */
export type SearchEngine = "brave" | "brave-llm" | "tavily" | "exa" | "serper" | "serpapi" | "you";
/**
 * Appends a `site:` operator to a raw keyword query for engines with no
 * structured domain-filter parameter (Brave, Serper, SerpApi) -- all three
 * are Google-style keyword search under the hood (Serper/SerpApi literally
 * scrape Google's own SERP), where `site:` is standard, widely-honoured
 * syntax. No-op when siteFilter is unset.
 */
export declare function withSiteFilter(query: string, siteFilter: string | undefined): string;
/** Header names worth capturing when present -- never a blanket capture of every response header. */
export declare const RATE_LIMIT_HEADER_PATTERN: RegExp;
//# sourceMappingURL=shared.d.ts.map