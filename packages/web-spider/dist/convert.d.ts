/**
 * Markdown conversion and chunk splitting.
 *
 * Owns the Turndown dependency. spider.ts calls toMarkdown() and chunk();
 * it never imports Turndown directly.
 */
import type { Chunk, ChunkType } from "./types.js";
export interface ToMarkdownOptions {
    /**
     * When true, <img> tags are rendered as ![alt](src) instead of being stripped.
     * Use when captureImages is enabled so image references appear in the markdown.
     * Default: false.
     */
    keepImages?: boolean;
}
/** Convert Readability article HTML to clean markdown. */
export declare function toMarkdown(html: string, opts?: ToMarkdownOptions): string;
/** Detect the dominant content type from a markdown buffer. */
export declare function detectContentType(lines: string[]): ChunkType;
/**
 * Split markdown into RAG-ready chunks at heading boundaries.
 *
 * Atomicity guarantees:
 *   - Fenced code blocks (``` ... ```) are never split.
 *   - Markdown tables (lines starting with |) are always flushed as a single
 *     chunk. Prose before the table is flushed first so the table is isolated.
 */
export declare function chunk(markdown: string, baseUrl: string): Chunk[];
//# sourceMappingURL=convert.d.ts.map