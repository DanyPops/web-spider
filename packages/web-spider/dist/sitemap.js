/**
 * Sitemap fetcher and parser.
 *
 * Attempts /sitemap.xml and /sitemap_index.xml. Extracts <loc> URLs.
 * Fails open — any error returns an empty array so callers fall back
 * to normal BFS without noise.
 */
/**
 * Fetch and parse sitemap URLs for the given origin.
 * Supports both standard sitemaps and sitemap index files.
 * Returns deduplicated absolute URLs, empty array on any failure.
 */
export async function fetchSitemapUrls(origin, httpClient) {
    const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
    const urls = new Set();
    for (const sitemapUrl of candidates) {
        try {
            const res = await httpClient.fetch({
                url: sitemapUrl,
                headers: { Accept: "application/xml, text/xml, */*" },
            });
            if (!res.ok)
                continue;
            const xml = await res.text();
            for (const loc of extractLocs(xml)) {
                // Sitemap index entries point to other sitemaps — fetch those too
                if (loc.endsWith(".xml")) {
                    const nested = await fetchSitemapXml(loc, httpClient);
                    for (const u of nested)
                        urls.add(u);
                }
                else {
                    urls.add(loc);
                }
            }
            if (urls.size > 0)
                break; // found a working sitemap
        }
        catch {
            continue;
        }
    }
    return [...urls];
}
async function fetchSitemapXml(url, httpClient) {
    try {
        const res = await httpClient.fetch({ url });
        if (!res.ok)
            return [];
        return extractLocs(await res.text());
    }
    catch {
        return [];
    }
}
function extractLocs(xml) {
    const urls = [];
    const re = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
    let match;
    while ((match = re.exec(xml)) !== null) {
        urls.push(match[1].trim());
    }
    return urls;
}
//# sourceMappingURL=sitemap.js.map