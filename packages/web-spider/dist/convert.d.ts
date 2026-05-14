/**
 * Markdown conversion and chunk splitting.
 *
 * Owns the Turndown dependency. spider.ts calls toMarkdown() and chunk();
 * it never imports Turndown directly.
 */
import type { Chunk, ChunkType } from "./types.js";
/** Convert Readability article HTML to clean markdown. */
export declare function toMarkdown(html: string): string;
/** Detect the dominant content type from a markdown buffer. */
export declare function detectContentType(lines: string[]): ChunkType;
/**
 * Split markdown into RAG-ready chunks at heading boundaries.
 * Tables and fenced code blocks are never split mid-block.
 */
export declare function chunk(markdown: string, baseUrl: string): Chunk[];
//# sourceMappingURL=convert.d.ts.map