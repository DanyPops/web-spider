/**
 * View transformations — business logic that converts a SpideredPage into
 * one of the available view shapes. Separated from types.ts which is pure
 * data-shape definitions.
 */
/**
 * Downgrade a full SpideredPage to a LeanPage.
 *
 * Pass a PageGraph as the second argument to populate `inboundCount` —
 * the number of other spidered pages that link to this one. Agents can
 * use this as a lightweight authority signal when ranking results from
 * a crawl without running a full PageRank pass.
 */
export function toLean(page, graph) {
    return {
        view: "lean",
        url: page.url,
        domain: page.domain,
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
        ...(graph !== undefined
            ? { inboundCount: graph.inbound(page.url).length }
            : {}),
    };
}
//# sourceMappingURL=views.js.map