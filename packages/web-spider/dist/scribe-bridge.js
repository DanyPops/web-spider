export function pageToRecords(page) {
    const records = [];
    records.push({
        type: "node",
        id: page.canonicalUrl ?? page.url,
        kind: "knowledge.source",
        title: page.title || page.url,
        labels: ["source:web-spider", `domain:${page.domain}`, ...page.tags.map((t) => `tag:${t}`)],
        sections: buildSections(page),
        extra: {
            url: page.url,
            fetchedAt: page.fetchedAt,
            wordCount: page.wordCount,
            readingTimeMinutes: page.readingTimeMinutes,
            lang: page.lang,
            author: page.author,
            publishedAt: page.publishedAt,
        },
    });
    for (const chunk of page.chunks) {
        records.push(chunkToNode(page, chunk));
        records.push({
            type: "edge",
            from: page.canonicalUrl ?? page.url,
            to: chunk.id,
            relation: "parent_of",
        });
    }
    for (const link of page.links) {
        if (link.rel === "body" && !link.isExternal) {
            records.push({
                type: "edge",
                from: page.canonicalUrl ?? page.url,
                to: link.href,
                relation: "cites",
            });
        }
    }
    return records;
}
export function pagesToNDJSON(pages) {
    const records = pages.flatMap(pageToRecords);
    records.push({
        type: "meta",
        source: "web-spider",
        scanned_at: new Date().toISOString(),
        total_nodes: records.filter((r) => r.type === "node").length,
        total_edges: records.filter((r) => r.type === "edge").length,
    });
    return records.map((r) => JSON.stringify(r)).join("\n");
}
export async function ingestToScribe(pages, ingestURL) {
    const body = pagesToNDJSON(pages);
    const url = `${ingestURL}?source=web-spider`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body,
    });
    if (!resp.ok) {
        console.warn(`scribe ingest: HTTP ${resp.status}`);
    }
}
function buildSections(page) {
    const sections = [];
    if (page.description)
        sections.push({ name: "description", text: page.description });
    if (page.markdown)
        sections.push({ name: "content", text: truncate(page.markdown, 4000) });
    if (page.headings.length > 0) {
        sections.push({
            name: "outline",
            text: page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n"),
        });
    }
    return sections;
}
function chunkToNode(page, chunk) {
    return {
        type: "node",
        id: chunk.id,
        kind: "support.paragraph",
        title: chunk.heading || `Chunk ${chunk.index}`,
        labels: ["source:web-spider", `domain:${page.domain}`],
        sections: [{ name: "text", text: chunk.text }],
        extra: {
            wordCount: chunk.wordCount,
            contentType: chunk.contentType,
            index: chunk.index,
            pageUrl: page.url,
        },
    };
}
function truncate(s, max) {
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}
//# sourceMappingURL=scribe-bridge.js.map