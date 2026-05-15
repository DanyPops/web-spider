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
export async function fetchSitemapUrls(
	origin: string,
	httpClient: IHttpClient,
): Promise<string[]> {
	const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
	const urls = new Set<string>();

	for (const sitemapUrl of candidates) {
		try {
			const res = await httpClient.fetch({
				url: sitemapUrl,
				headers: { Accept: "application/xml, text/xml, */*" },
			});
			if (!res.ok) continue;
			const xml = await res.text();
			for (const loc of extractLocs(xml)) {
				// Sitemap index entries point to other sitemaps — fetch those too
				if (loc.endsWith(".xml")) {
					const nested = await fetchSitemapXml(loc, httpClient);
					for (const u of nested) urls.add(u);
				} else {
					urls.add(loc);
				}
			}
			if (urls.size > 0) break; // found a working sitemap
		} catch {
			continue;
		}
	}

	return [...urls];
}

async function fetchSitemapXml(url: string, httpClient: IHttpClient): Promise<string[]> {
	try {
		const res = await httpClient.fetch({ url });
		if (!res.ok) return [];
		return extractLocs(await res.text());
	} catch {
		return [];
	}
}

function extractLocs(xml: string): string[] {
	const urls: string[] = [];
	const re = /<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) {
		urls.push(match[1].trim());
	}
	return urls;
}
