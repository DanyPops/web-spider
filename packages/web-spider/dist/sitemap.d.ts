/**
 * Sitemap fetcher and parser.
 *
 * Attempts /sitemap.xml and /sitemap_index.xml. Extracts <loc> URLs.
 * Fails open — any error returns an empty array so callers fall back
 * to normal BFS without noise.
 */
import type { IHttpClient } from "./ports.js";
/**
 * Fetch and parse sitemap URLs for the given origin.
 * Supports both standard sitemaps and sitemap index files.
 * Returns deduplicated absolute URLs, empty array on any failure.
 */
export declare function fetchSitemapUrls(origin: string, httpClient: IHttpClient): Promise<string[]>;
//# sourceMappingURL=sitemap.d.ts.map