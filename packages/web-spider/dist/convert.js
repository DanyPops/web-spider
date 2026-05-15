/**
 * Markdown conversion and chunk splitting.
 *
 * Owns the Turndown dependency. spider.ts calls toMarkdown() and chunk();
 * it never imports Turndown directly.
 */
import TurndownService from "turndown";
// ---------------------------------------------------------------------------
// Turndown setup
// ---------------------------------------------------------------------------
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Disable escape — Turndown escapes markdown-special chars by default,
// producing backslash noise that is unnatural for agent consumption.
turndown.escape = (s) => s;
// Strip images — agents cannot see them and alt-text is noise.
turndown.addRule("strip-images", {
    filter: "img",
    replacement: () => "",
});
// ---------------------------------------------------------------------------
// Markdown conversion
// ---------------------------------------------------------------------------
/** Convert Readability article HTML to clean markdown. */
export function toMarkdown(html) {
    return turndown.turndown(html);
}
// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------
const CHUNK_TARGET_WORDS = 150;
/** Detect the dominant content type from a markdown buffer. */
export function detectContentType(lines) {
    for (const line of lines) {
        const t = line.trim();
        if (!t)
            continue;
        if (t.startsWith("```"))
            return "code";
        if (t.startsWith("|"))
            return "table";
        if (/^[-*+] /.test(t) || /^\d+\. /.test(t))
            return "list";
        if (t.startsWith(">"))
            return "blockquote";
        return "text";
    }
    return "text";
}
// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
/**
 * Split markdown into RAG-ready chunks at heading boundaries.
 *
 * Atomicity guarantees:
 *   - Fenced code blocks (``` ... ```) are never split.
 *   - Markdown tables (lines starting with |) are always flushed as a single
 *     chunk. Prose before the table is flushed first so the table is isolated.
 */
export function chunk(markdown, baseUrl) {
    const chunks = [];
    const lines = markdown.split("\n");
    let heading = "";
    let buffer = [];
    let index = 0;
    let inCode = false;
    let inTable = false;
    const flush = () => {
        const text = buffer.join("\n").trim();
        if (!text)
            return;
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        if (wordCount < 10)
            return;
        const contentType = detectContentType(buffer);
        chunks.push({ id: `${baseUrl}#chunk-${index}`, index, heading, text, wordCount, contentType });
        index++;
        buffer = [];
    };
    for (const line of lines) {
        const trimmed = line.trim();
        // ── Fenced code block toggle ──────────────────────────────────────────
        if (trimmed.startsWith("```")) {
            inCode = !inCode;
            buffer.push(line);
            continue;
        }
        if (inCode) {
            buffer.push(line);
            continue;
        }
        // ── Table rows ────────────────────────────────────────────────────────
        const isTableRow = trimmed.startsWith("|");
        if (isTableRow) {
            if (!inTable) {
                // Table is starting — flush any preceding prose so the table
                // gets its own isolated chunk.
                flush();
                inTable = true;
            }
            buffer.push(line);
            continue;
        }
        if (inTable) {
            // Table just ended — flush it before processing the next line.
            flush();
            inTable = false;
        }
        // ── Normal prose / headings ───────────────────────────────────────────
        if (!trimmed) {
            buffer.push(line);
            continue;
        }
        const headingMatch = /^#{1,3} (.+)/.exec(trimmed);
        if (headingMatch) {
            const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
            if (currentWords >= CHUNK_TARGET_WORDS)
                flush();
            heading = headingMatch[1];
            buffer.push(line);
        }
        else {
            buffer.push(line);
            const currentWords = buffer.join(" ").split(/\s+/).filter(Boolean).length;
            if (currentWords >= CHUNK_TARGET_WORDS)
                flush();
        }
    }
    flush();
    return chunks;
}
//# sourceMappingURL=convert.js.map