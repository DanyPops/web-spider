/**
 * Downgrade a full SpideredPage to a LeanPage.
 * Use when you have already fetched full but only need the outline in context.
 */
export function toLean(page) {
    return {
        view: "lean",
        url: page.url,
        domain: page.domain,
        fetchedAt: page.fetchedAt,
        ...(page.canonicalUrl !== undefined ? { canonicalUrl: page.canonicalUrl } : {}),
        title: page.title,
        ...(page.description ? { description: page.description } : {}),
        ...(page.author ? { author: page.author } : {}),
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        lang: page.lang,
        tags: page.tags,
        wordCount: page.wordCount,
        readingTimeMinutes: page.readingTimeMinutes,
        chunkCount: page.chunks.length,
        headings: page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`),
        links: page.links
            .filter((l) => l.rel === "body")
            .slice(0, 10)
            .map((l) => ({ href: l.href, text: l.text })),
    };
}
//# sourceMappingURL=types.js.map